import {
  type CustomModelSetting,
  LIBRAOS_GATEWAY_ORIGIN,
  type LibraosGatewayModel,
} from "@t3tools/contracts";
import type { EndpointKeyModels } from "@t3tools/provider-core/server/snapshotProbe";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  type ClaudeModelCatalog,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  GATEWAY_KEY_SECRET,
  gatewayAgentModels,
  gatewayRefusal,
  isKeyRefusal,
  parseGatewayModels,
} from "./gatewaySetup.ts";

const CHECK_TIMEOUT = Duration.seconds(15);

export type GatewayModelsAnswer =
  | { readonly kind: "models"; readonly models: ReadonlyArray<LibraosGatewayModel> }
  /** 401/403: the key is revoked, deleted or may not list models. */
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Asks `<base>/models` which models `key` allows; `base` ends in `/v1`. Never fails: an unreachable
 * gateway is an answer. `name` is how its messages call it.
 */
export const askModels = Effect.fn("Gateway.askModels")(function* (gateway: {
  readonly base: string;
  readonly name: string;
  readonly key: string | null;
}) {
  const http = yield* HttpClient.HttpClient;
  const unreachable: GatewayModelsAnswer = {
    kind: "unavailable",
    message: `Couldn't reach ${gateway.name} at ${new URL(gateway.base).host}. Check your connection.`,
  };
  const request = HttpClientRequest.get(`${gateway.base}/models`).pipe(
    HttpClientRequest.acceptJson,
  );
  const ask = Effect.gen(function* () {
    const response = yield* http
      .execute(gateway.key === null ? request : HttpClientRequest.bearerToken(request, gateway.key))
      .pipe(
        // A redirect could carry the key to another origin.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.option,
      );
    if (response._tag === "None") return unreachable;
    const body = yield* response.value.json.pipe(Effect.orElseSucceed((): unknown => undefined));
    const status = response.value.status;
    if (status < 200 || status >= 300) {
      const message = gatewayRefusal(status, body, {
        name: gateway.name,
        ...(gateway.key === null ? {} : { key: gateway.key }),
      });
      return (
        isKeyRefusal(status) ? { kind: "refused", message } : { kind: "unavailable", message }
      ) satisfies GatewayModelsAnswer;
    }
    const models = parseGatewayModels(body);
    return (
      models === null
        ? {
            kind: "unavailable",
            message: `${gateway.name} answered with an unreadable model list.`,
          }
        : { kind: "models", models }
    ) satisfies GatewayModelsAnswer;
  });
  // The deadline covers the body too: a gateway that stalls mid-answer must not hold a refresh.
  return yield* ask.pipe(
    Effect.timeoutOption(CHECK_TIMEOUT),
    Effect.map(Option.getOrElse(() => unreachable)),
  );
});

/** Asks LibraOS Gateway which models `key` allows. */
export const askGatewayModels = (key: string) =>
  askModels({ base: `${LIBRAOS_GATEWAY_ORIGIN}/v1`, name: "LibraOS Gateway", key });

/**
 * Every model the key an agent sends to the Gateway allows (`family`'s own without the prefix, the
 * rest by full id); another endpoint is not asked. Down Gateway: the key's last answer (a refusal is empty),
 * else `known` only for the connected key it was stored from, else none.
 */
export const makeGatewayKeyModels = Effect.fn("LibraosGateway.makeGatewayKeyModels")(function* (
  family?: "anthropic" | "openai",
) {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const connectedKey = Option.match(secrets, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (store) =>
      store.get(GATEWAY_KEY_SECRET).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
  });
  // In memory only, beside the environment the key was read from; never written or logged.
  const lastAllowed = new Map<string, ReadonlyArray<CustomModelSetting>>();
  const keyModels: EndpointKeyModels = ({ endpoint, key, known }) => {
    if (endpoint !== LIBRAOS_GATEWAY_ORIGIN) return Effect.undefined;
    if (!key) return Effect.succeed([]);
    return askGatewayModels(key).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flatMap((answer): Effect.Effect<ReadonlyArray<CustomModelSetting>> => {
        if (answer.kind === "models") {
          const models = family
            ? gatewayAgentModels(answer.models, family)
            : answer.models.map((model) => ({
                slug: model.id,
                ...(model.name ? { name: model.name } : {}),
              }));
          lastAllowed.set(key, models);
          return Effect.succeed(models);
        }
        if (answer.kind === "refused") {
          lastAllowed.set(key, []);
          return Effect.succeed([]);
        }
        const last = lastAllowed.get(key);
        if (last !== undefined || known === undefined) return Effect.succeed(last ?? []);
        return connectedKey.pipe(
          Effect.map((connected) =>
            Option.isSome(connected) && connected.value === key ? known : [],
          ),
        );
      }),
    );
  };
  return keyModels;
});

/**
 * Keeps the list `keyModels` last gave this agent, so its turns read an id the way its picker
 * showed it even when the agent's own settings list no models (a hand-configured endpoint).
 * `routed` waits for the first answer (or `settle`, when no check reaches the Gateway), so a turn
 * dispatched while the list is still pending does not read the agent's whole catalog.
 */
export const rememberServedModels = Effect.fn("LibraosGateway.rememberServedModels")(function* (
  keyModels: EndpointKeyModels,
) {
  const served = yield* Ref.make<ReadonlyArray<CustomModelSetting> | undefined>(undefined);
  const answered = yield* Deferred.make<void>();
  const settle = Deferred.succeed(answered, undefined).pipe(Effect.asVoid);
  const remembering: EndpointKeyModels = (input) =>
    keyModels(input).pipe(
      Effect.tap((models) => Ref.set(served, models)),
      Effect.ensuring(settle),
    );
  const routed = Effect.fn("LibraosGateway.routedCatalog")(function* (catalog: ClaudeModelCatalog) {
    // Same allowance as Claude's model routes; an expired wait counts as settled.
    yield* Deferred.await(answered).pipe(Effect.timeoutOption("2 minutes"), Effect.andThen(settle));
    const models = yield* Ref.get(served);
    return models === undefined ? catalog : gatewayClaudeCatalog(catalog, models);
  });
  return { keyModels: remembering, settle, routed };
});

/**
 * The key's models are its exact ids: Claude's catalog aliases do not apply, so a literal `opus`
 * the key dropped is sent as `opus` (and refused there), not as the model the alias names.
 */
function gatewayClaudeCatalog(
  catalog: ClaudeModelCatalog,
  models: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const scoped = scopeClaudeModelCatalog(catalog, models);
  return {
    models: scoped.models.map((entry) =>
      entry.model.aliases?.length ? { ...entry, model: { ...entry.model, aliases: [] } } : entry,
    ),
  };
}
