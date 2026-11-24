import {
  CustomGatewayError,
  type CustomGatewaySaveInput,
  type CustomGatewayAddResult,
  type CustomGatewayList,
  type CustomGatewaySetting,
  type CustomGatewaySummary,
  type LibraosGatewayModel,
  type ProviderInstanceConfigMap,
  customGatewayAgentsOf,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { askModels } from "./gatewayKeyModels.ts";
import {
  customGatewayInstanceIds,
  customGatewayInstances,
  extendCustomGatewayInstances,
  nextGatewayAccentColor,
  customGatewayKeySecret,
  customGatewayModels,
  customPiTarget,
  newCustomGatewayId,
  trimGatewayUrl,
  withCustomGateway,
} from "./gatewaySetup.ts";
import {
  backfillPiOnce,
  choosePiFirstRunDefault,
  clearPiDefault,
  hadPiGatewayAgent,
  piGatewayAgentDir,
  removePiGatewayAgentDir,
  writePiGatewayAgentDir,
} from "./piGatewayAgent.ts";

export class CustomGateway extends Context.Service<
  CustomGateway,
  {
    readonly list: Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /**
     * Adds a gateway using the fetched or supplied models, or extends a saved gateway to both
     * formats using its existing models. An unreadable model list leaves the gateway unsaved.
     */
    readonly add: (
      input: CustomGatewaySaveInput,
    ) => Effect.Effect<CustomGatewayAddResult, CustomGatewayError>;
    /** A blank name names the gateway after its URL. */
    readonly rename: (
      id: string,
      name: string,
    ) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Turns off the listed models for every agent of the gateway; at least one stays on. */
    readonly setHiddenModels: (
      id: string,
      hiddenModels: ReadonlyArray<string>,
    ) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Removes the gateway's agents and key; nothing else. */
    readonly remove: (id: string) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Gives the agents the gateway's current list; one it cannot read leaves the last one. */
    readonly refreshModels: (id: string) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Where to send requests and with which key; for the server only, never a client. */
    readonly connection: (id: string) => Effect.Effect<CustomGatewayConnection, CustomGatewayError>;
    /** Gives OpenAI-format gateways added before they had a Pi agent that agent, once; runs at start. */
    readonly backfillPi: Effect.Effect<void>;
  }
>()("t3/gateway/CustomGateway") {}

export interface CustomGatewayConnection {
  readonly id: string;
  readonly name: string;
  readonly base: string;
  readonly key: string | null;
}

const fail = (message: string) => new CustomGatewayError({ message });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The URL as typed without trailing slashes, if it is http(s). */
function readGatewayUrl(raw: string): string | null {
  const url = trimGatewayUrl(raw);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const ALL_AGENTS = ["claude", "codex", "opencode", "pi"] as const;

const agentsOf = (instances: Record<string, unknown>, id: string) => {
  const ids = customGatewayInstanceIds(id);
  return ALL_AGENTS.filter((agent) => Object.hasOwn(instances, ids[agent]));
};

function summarize(
  instances: ProviderInstanceConfigMap,
  gateway: CustomGatewaySetting,
  hasKey: boolean,
): CustomGatewaySummary {
  const models = (customGatewayModels(instances, gateway.id) ?? []).map((model) => model.id);
  return {
    ...gateway,
    hasKey,
    agents: agentsOf(instances, gateway.id),
    modelCount: models.length,
    models,
    hiddenModels: gateway.hiddenModels ?? [],
  };
}

const baseOf = (url: string) => `${url.replace(/\/v1$/, "")}/v1`;

function typedModels(ids: ReadonlyArray<string>): ReadonlyArray<LibraosGatewayModel> {
  const unique = new Set(ids.map((id) => id.trim()).filter((id) => id !== ""));
  return Array.from(unique, (id) => ({ id }));
}

export const make = Effect.fn("CustomGateway.make")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const piDirOf = (id: string) =>
    piGatewayAgentDir(path, stateDir, customGatewayInstanceIds(id).pi);

  const storageFailure = (what: string) => (cause: unknown) =>
    Effect.logWarning(`Custom gateway: failed to ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(fail(`Could not ${what} on this host.`))),
    );

  const readSettings = settings.getSettings.pipe(Effect.catch(storageFailure("read settings")));

  const readKey = (id: string) =>
    secrets
      .get(customGatewayKeySecret(id))
      .pipe(
        Effect.map(Option.map((bytes) => textDecoder.decode(bytes).trim())),
        Effect.map(Option.filter((key) => key !== "")),
        Effect.map(Option.getOrNull),
        Effect.catch(storageFailure("read the gateway's key")),
      );

  const writePi = (
    gateway: CustomGatewaySetting,
    hasKey: boolean,
    models: ReadonlyArray<LibraosGatewayModel>,
  ) =>
    withFiles(
      writePiGatewayAgentDir(piDirOf(gateway.id), customPiTarget(gateway, hasKey), models),
    ).pipe(Effect.catch(storageFailure("write the Pi agent's model list")));

  /** Before the agents get `models`, so the Pi agent's next start already reads them. */
  const syncPi = Effect.fn("CustomGateway.syncPi")(function* (
    gateway: CustomGatewaySetting,
    models: ReadonlyArray<LibraosGatewayModel>,
  ) {
    const current = yield* readSettings;
    if (current.providerInstances[customGatewayInstanceIds(gateway.id).pi] === undefined) return;
    yield* writePi(gateway, (yield* readKey(gateway.id)) !== null, models);
  });

  const ask = (gateway: CustomGatewaySetting, key: string | null) =>
    askModels({ base: baseOf(gateway.url), name: gateway.name, key }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

  const list: CustomGateway["Service"]["list"] = Effect.gen(function* () {
    const current = yield* readSettings;
    const gateways = yield* Effect.forEach(current.customGateways, (gateway) =>
      readKey(gateway.id).pipe(
        Effect.map((key) => summarize(current.providerInstances, gateway, key !== null)),
      ),
    );
    return { gateways };
  }).pipe(Effect.withSpan("CustomGateway.list"));

  const find = Effect.fn("CustomGateway.find")(function* (id: string) {
    const gateway = (yield* readSettings).customGateways.find((entry) => entry.id === id);
    if (gateway === undefined) return yield* fail("That gateway is no longer here.");
    return gateway;
  });

  const extend = Effect.fn("CustomGateway.extend")(function* (
    input: Extract<CustomGatewaySaveInput, { extendId: string }>,
  ) {
    const id = input.extendId;
    const current = yield* readSettings;
    const gateway = current.customGateways.find((entry) => entry.id === id);
    if (gateway === undefined) return yield* fail("That gateway is no longer here.");
    const storedKey = yield* readKey(id);
    if (gateway.format === "both") {
      return {
        kind: "added",
        gateway: summarize(current.providerInstances, gateway, storedKey !== null),
      } satisfies CustomGatewayAddResult;
    }
    const key = storedKey ?? (input.key?.trim() || null);
    if (key === null) return yield* fail("Claude Code needs a key for this gateway.");
    const models = customGatewayModels(current.providerInstances, id);
    if (!models?.length) return yield* fail("This gateway has no models to share.");
    const updated = { ...gateway, format: "both" } as const;
    const addedKey = storedKey === null;
    const piId = customGatewayInstanceIds(id).pi;
    const hasPi = current.providerInstances[piId] !== undefined;
    const addPi = gateway.format === "anthropic" && !hasPi;
    const updatePi = addedKey && hasPi;
    const writeKey = secrets
      .set(customGatewayKeySecret(id), textEncoder.encode(key))
      .pipe(Effect.catch(storageFailure("store the gateway's key")));

    const saved = yield* Effect.gen(function* () {
      if (addedKey) yield* writeKey;
      if (addPi || updatePi) yield* writePi(updated, true, models);
      return yield* settings
        .updateProviderInstances(
          (instances) =>
            extendCustomGatewayInstances(
              instances,
              { ...updated, key, models, piAgentDir: piDirOf(id) },
              gateway.format === "openai" ? "claude" : "codex",
              addedKey,
              addPi,
            ),
          {
            customGateways: current.customGateways.map((entry) =>
              entry.id === id ? updated : entry,
            ),
          },
        )
        .pipe(Effect.catch(storageFailure("save the gateway and its agents")));
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          if (addPi) {
            yield* withFiles(removePiGatewayAgentDir(piDirOf(id))).pipe(
              Effect.ignore({ log: true }),
            );
          }
          if (updatePi) {
            yield* writePi(gateway, false, models).pipe(Effect.ignore({ log: true }));
          }
          if (addedKey) {
            yield* secrets.remove(customGatewayKeySecret(id)).pipe(Effect.ignore({ log: true }));
          }
        }),
      ),
      Effect.uninterruptible,
    );
    if (addPi) {
      yield* withFiles(choosePiFirstRunDefault(settings, piId)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Custom gateway: could not make Pi the default agent", { cause }),
        ),
      );
    }
    return {
      kind: "added",
      gateway: summarize(saved.providerInstances, updated, true),
    } satisfies CustomGatewayAddResult;
  });

  const add: CustomGateway["Service"]["add"] = (input) => {
    if ("extendId" in input) return lock.withPermits(1)(extend(input));
    return lock
      .withPermits(1)(
        Effect.gen(function* () {
          const url = readGatewayUrl(input.url);
          if (url === null) return yield* fail("Enter the gateway's http:// or https:// URL.");
          const key = input.key?.trim() || null;
          // Without one, Claude Code would send the person's own Claude login to this gateway.
          if (input.format !== "openai" && key === null) {
            return yield* fail("An Anthropic-format gateway needs a key.");
          }
          const agents = customGatewayAgentsOf(input.format).filter(
            (agent) => input.agents === undefined || input.agents.includes(agent),
          );
          if (agents.length === 0) {
            return yield* fail("Pick at least one agent that works with this format.");
          }
          const existing = (yield* readSettings).customGateways;
          let id = newCustomGatewayId();
          while (existing.some((entry) => entry.id === id)) id = newCustomGatewayId();
          const gateway: CustomGatewaySetting = {
            id,
            name: input.name?.trim() || url,
            url,
            format: input.format,
          };
          let models: ReadonlyArray<LibraosGatewayModel>;
          if (input.models !== undefined) {
            models = typedModels(input.models);
            if (models.length === 0) return yield* fail("Enter at least one model id.");
          } else {
            const answer = yield* ask(gateway, key);
            if (answer.kind !== "models") {
              return {
                kind: "modelsProblem",
                message: answer.message,
              } satisfies CustomGatewayAddResult;
            }
            if (answer.models.length === 0) {
              return {
                kind: "modelsProblem",
                message: `${gateway.name} lists no models.`,
              } satisfies CustomGatewayAddResult;
            }
            models = answer.models;
          }
          const ids = customGatewayInstanceIds(id);
          const withPi = agents.includes("pi");
          const instances = customGatewayInstances({
            ...gateway,
            key,
            models,
            piAgentDir: piDirOf(id),
          }).filter(({ instanceId }) => agents.some((agent) => ids[agent] === instanceId));
          yield* Effect.gen(function* () {
            if (key !== null) {
              yield* secrets
                .set(customGatewayKeySecret(id), textEncoder.encode(key))
                .pipe(Effect.catch(storageFailure("store the gateway's key")));
            }
            if (withPi) yield* writePi(gateway, key !== null, models);
            yield* settings
              .updateProviderInstances(
                (current) => {
                  const accentColor = nextGatewayAccentColor(current);
                  return {
                    ...current,
                    ...Object.fromEntries(
                      instances.map(({ instanceId, instance }) => [
                        instanceId,
                        { ...instance, accentColor },
                      ]),
                    ),
                  };
                },
                { customGateways: [...existing, gateway] },
              )
              .pipe(Effect.catch(storageFailure("save the gateway and its agents")));
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                if (withPi) {
                  yield* withFiles(removePiGatewayAgentDir(piDirOf(id))).pipe(
                    Effect.ignore({ log: true }),
                  );
                }
                if (key !== null) {
                  yield* secrets
                    .remove(customGatewayKeySecret(id))
                    .pipe(Effect.ignore({ log: true }));
                }
              }),
            ),
            Effect.uninterruptible,
          );
          if (withPi) {
            yield* withFiles(choosePiFirstRunDefault(settings, ids.pi)).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Custom gateway: could not make Pi the default agent", { cause }),
              ),
            );
          }
          return {
            kind: "added",
            gateway: {
              ...gateway,
              hasKey: key !== null,
              modelCount: models.length,
              models: models.map((model) => model.id),
              hiddenModels: [],
              agents,
            },
          } satisfies CustomGatewayAddResult;
        }),
      )
      .pipe(Effect.withSpan("CustomGateway.add"));
  };

  const rename: CustomGateway["Service"]["rename"] = (id, name) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const gateway = yield* find(id);
          const renamed = { ...gateway, name: name.trim() || gateway.url };
          yield* settings
            .updateProviderInstances((current) => withCustomGateway(current, renamed, null))
            .pipe(Effect.catch(storageFailure("rename the gateway's agents")));
          const stored = (yield* readSettings).customGateways;
          yield* settings
            .updateSettings({
              customGateways: stored.map((entry) => (entry.id === id ? renamed : entry)),
            })
            .pipe(Effect.catch(storageFailure("save the gateway")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.rename"));

  const setHiddenModels: CustomGateway["Service"]["setHiddenModels"] = (id, hiddenModels) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const gateway = yield* find(id);
          const current = yield* readSettings;
          const shown = customGatewayModels(current.providerInstances, id) ?? [];
          const known = [
            ...shown,
            ...(gateway.hiddenModels ?? [])
              .filter((model) => !shown.some((entry) => entry.id === model))
              .map((model) => ({ id: model })),
          ];
          const hidden = known
            .map((model) => model.id)
            .filter((model) => hiddenModels.includes(model));
          const models = known.filter((model) => !hidden.includes(model.id));
          if (models.length === 0) return yield* fail("Keep at least one model on.");
          const updated = { ...gateway, hiddenModels: hidden };
          yield* syncPi(gateway, models);
          yield* settings
            .updateProviderInstances((instances) => withCustomGateway(instances, gateway, models))
            .pipe(Effect.catch(storageFailure("update the gateway's agents")));
          yield* settings
            .updateSettings({
              customGateways: current.customGateways.map((entry) =>
                entry.id === id ? updated : entry,
              ),
            })
            .pipe(Effect.catch(storageFailure("save the gateway")));
        }),
      )
      // A client that goes away mid-save must not leave a model off with no record of it.
      .pipe(
        Effect.uninterruptible,
        Effect.andThen(list),
        Effect.withSpan("CustomGateway.setHiddenModels"),
      );

  const remove: CustomGateway["Service"]["remove"] = (id) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readSettings;
          for (const instanceId of Object.values(customGatewayInstanceIds(id))) {
            if (!Object.hasOwn(current.providerInstances, instanceId)) continue;
            yield* settings
              .updateProviderInstance({ operation: "remove", instanceId })
              .pipe(Effect.catch(storageFailure("remove the gateway's agents")));
          }
          yield* secrets
            .remove(customGatewayKeySecret(id))
            .pipe(Effect.catch(storageFailure("remove the gateway's key")));
          yield* withFiles(removePiGatewayAgentDir(piDirOf(id))).pipe(
            Effect.catch(storageFailure("remove the Pi agent's directory")),
          );
          yield* clearPiDefault(settings, customGatewayInstanceIds(id).pi).pipe(
            Effect.catch(storageFailure("clear the default agent")),
          );
          const stored = (yield* readSettings).customGateways;
          yield* settings
            .updateSettings({ customGateways: stored.filter((entry) => entry.id !== id) })
            .pipe(Effect.catch(storageFailure("remove the gateway")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.remove"));

  const refreshModels: CustomGateway["Service"]["refreshModels"] = (id) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const gateway = yield* find(id);
          const answer = yield* ask(gateway, yield* readKey(id));
          // Ids typed because the list was unreadable stay until it can be read.
          if (answer.kind !== "models") return yield* fail(answer.message);
          if (answer.models.length === 0) return yield* fail(`${gateway.name} lists no models.`);
          const hidden = gateway.hiddenModels ?? [];
          const offered = answer.models.filter((model) => !hidden.includes(model.id));
          // Every listed model turned off would leave agents with nothing: offer the list again.
          const models = offered.length > 0 ? offered : answer.models;
          yield* syncPi(gateway, models);
          yield* settings
            .updateProviderInstances((current) => withCustomGateway(current, gateway, models))
            .pipe(Effect.catch(storageFailure("update the gateway's agents")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.refreshModels"));

  const connection: CustomGateway["Service"]["connection"] = Effect.fn("CustomGateway.connection")(
    function* (id) {
      const gateway = yield* find(id);
      return { id, name: gateway.name, base: baseOf(gateway.url), key: yield* readKey(id) };
    },
  );

  const backfillPi: CustomGateway["Service"]["backfillPi"] = lock
    .withPermits(1)(
      withFiles(
        backfillPiOnce(
          stateDir,
          "custom",
          Effect.gen(function* () {
            const current = yield* readSettings;
            for (const gateway of current.customGateways) {
              if (gateway.format !== "openai") continue;
              const ids = customGatewayInstanceIds(gateway.id);
              const present = current.providerInstances[ids.pi] !== undefined;
              if (yield* hadPiGatewayAgent(present, piDirOf(gateway.id))) continue;
              const models = customGatewayModels(current.providerInstances, gateway.id);
              if (models === null || models.length === 0) continue;
              const key = yield* readKey(gateway.id);
              yield* writePi(gateway, key !== null, models);
              const accentColor =
                current.providerInstances[ids.codex]?.accentColor ??
                current.providerInstances[ids.opencode]?.accentColor;
              for (const { instanceId, instance } of customGatewayInstances({
                ...gateway,
                key,
                models,
                piAgentDir: piDirOf(gateway.id),
              })) {
                if (instanceId !== ids.pi) continue;
                yield* settings.updateProviderInstance({
                  operation: "upsert",
                  instanceId,
                  instance: accentColor === undefined ? instance : { ...instance, accentColor },
                });
              }
              yield* choosePiFirstRunDefault(settings, ids.pi);
            }
            return true;
          }),
        ),
      ),
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Custom gateway: could not add the Pi agents", { cause }),
      ),
      Effect.withSpan("CustomGateway.backfillPi"),
    );

  yield* settings.ready.pipe(
    Effect.andThen(backfillPi),
    Effect.catch((cause) =>
      Effect.logWarning("Custom gateway: startup backfill failed", { cause }),
    ),
    Effect.forkScoped,
  );

  return CustomGateway.of({
    backfillPi,
    list,
    add,
    rename,
    setHiddenModels,
    remove,
    refreshModels,
    connection,
  });
});

export const layer = Layer.effect(CustomGateway, make()).pipe(Layer.provide(FetchHttpClient.layer));
