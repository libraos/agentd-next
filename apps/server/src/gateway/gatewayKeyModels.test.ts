// @effect-diagnostics nodeBuiltinImport:off - one test serves a real certificate this computer does not trust.
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import { ProviderInstanceId } from "@t3tools/contracts";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";

import {
  askGatewayModels,
  askModels,
  makeGatewayKeyModels,
  rememberServedModels,
} from "./gatewayKeyModels.ts";
import { GATEWAY_KEY_SECRET } from "./gatewaySetup.ts";

// Another family's model keeps its Gateway id, sits under its family and has no agent options.
const otherFamily = (slug: string, name?: string) => ({
  slug,
  ...(name ? { name } : {}),
  subProvider: slug.split("/")[0],
  capabilities: { optionDescriptors: [] },
});
// The agent's own family by its full id: options come from the catalog model it names.
const ownFullId = (slug: string) => ({ slug, subProvider: slug.split("/")[0] });

const KEY = "lk_codex_key_0123456789";
const CONNECTED = "lk_connected_key_5555";

const secretStore = ServerSecretStore.ServerSecretStore.of({
  get: (name) =>
    Effect.succeed(
      name === GATEWAY_KEY_SECRET
        ? Option.some(new TextEncoder().encode(CONNECTED))
        : Option.none(),
    ),
  set: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  create: () => Effect.die("unused"),
  getOrCreateRandom: () => Effect.die("unused"),
});

it.effect("an agent's own Gateway key decides its models", () => {
  const requests: Array<string | undefined> = [];
  let answer: Response = Response.json({
    data: [
      { id: "anthropic/claude-opus-5-5" },
      { id: "openai/gpt-6-astra" },
      { id: "gemini/gemini-2.5-pro" },
    ],
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.headers.authorization);
      return HttpClientResponse.fromWeb(request, answer);
    }),
  );
  return Effect.gen(function* () {
    const keyModels = yield* makeGatewayKeyModels("openai");
    const ask = (endpoint: string) => keyModels({ endpoint, key: KEY });

    const allowed = [
      { slug: "gpt-6-astra" },
      ownFullId("openai/gpt-6-astra"),
      otherFamily("anthropic/claude-opus-5-5"),
      otherFamily("gemini/gemini-2.5-pro"),
    ];
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), allowed);
    assert.deepStrictEqual(requests, [`Bearer ${KEY}`]);

    // Another endpoint is not asked: the key goes only where the agent sends it anyway.
    assert.isUndefined(yield* ask("https://hub.example.com"));
    assert.strictEqual(requests.length, 1);

    // An outage keeps what the key allowed, never the agent's whole catalog.
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), allowed);
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: "lk_other_key_9876543210" }),
      [],
    );
    // A Gateway agent's stored list is the connected key's: it stands while the Gateway has not
    // answered for that key, and never for another key.
    const known = [{ slug: "gpt-6-luna" }];
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: CONNECTED, known }),
      known,
    );
    assert.deepStrictEqual(
      yield* keyModels({
        endpoint: "https://api.libraos.com",
        key: "lk_other_key_9876543210",
        known,
      }),
      [],
    );

    // A refusal is an answer: a later outage keeps it, not the connected key's stored list.
    answer = Response.json({ error: { message: "This API key is not valid." } }, { status: 401 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: KEY, known }),
      [],
    );

    // The agent sends no key, so the Gateway serves it nothing.
    const asked = requests.length;
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: undefined }),
      [],
    );
    assert.strictEqual(requests.length, asked);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
  );
});

it.effect(
  "a hand-configured Claude agent runs a key's bare alias id as the picker shows it",
  () => {
    let listed = [{ id: "opus" }, { id: "anthropic/claude-opus-5-5" }];
    const http = HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, Response.json({ data: listed }))),
    );
    return Effect.gen(function* () {
      // Its own settings list no models: only the key's answer says `opus` is the Gateway's id.
      const { keyModels, routed } = yield* rememberServedModels(
        yield* makeGatewayKeyModels("anthropic"),
      );
      const compile = Effect.map(routed(BUNDLED_CLAUDE_MODEL_CATALOG), (catalog) =>
        compileClaudeModelSelection(
          { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
          catalog,
        ),
      );
      // A turn dispatched before the key's list arrives waits for it, rather than expanding the
      // alias with Claude's whole catalog.
      const early = yield* compile.pipe(Effect.forkChild);
      yield* keyModels({ endpoint: "https://api.libraos.com", key: KEY });
      const compiled = yield* Fiber.join(early);
      assert.strictEqual(compiled.apiModelId, "opus");
      assert.strictEqual(compiled.pinnedAlias, "opus");

      // The key drops the literal `opus`: it stays `opus`, not the Opus 5.5 its alias names.
      listed = [{ id: "anthropic/claude-opus-5-5" }];
      yield* keyModels({ endpoint: "https://api.libraos.com", key: KEY });
      const revoked = yield* compile;
      assert.strictEqual(revoked.apiModelId, "opus");
      assert.strictEqual(revoked.pinnedAlias, "opus");

      // Another endpoint serves every model: Claude Code's own alias applies again.
      yield* keyModels({ endpoint: "https://hub.example.com", key: KEY });
      assert.strictEqual((yield* compile).pinnedAlias, undefined);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  },
);

it.effect("a Claude agent no check sends to the Gateway routes once its check ends", () =>
  Effect.gen(function* () {
    const { settle, routed } = yield* rememberServedModels(() => Effect.undefined);
    const waiting = yield* routed(BUNDLED_CLAUDE_MODEL_CATALOG).pipe(Effect.forkChild);
    yield* settle;
    assert.strictEqual(yield* Fiber.join(waiting), BUNDLED_CLAUDE_MODEL_CATALOG);
  }),
);

it.effect("a Gateway that stalls while sending its list times out", () => {
  // Headers arrive, the body never ends.
  const http = HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream({ start: () => {} }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const fiber = yield* askGatewayModels(KEY).pipe(Effect.forkChild);
    yield* TestClock.adjust("16 seconds");
    const answer = yield* Fiber.join(fiber);
    assert.strictEqual(answer.kind, "unavailable");
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

// Non-secret, self-signed 127.0.0.1 certificate, the one outboundHttp.test.ts serves.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

it.live("a gateway whose certificate isn't trusted says so instead of blaming the connection", () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttps.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_, response) =>
        response.end("{}"),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  ).pipe(
    Effect.flatMap((server) =>
      askModels({
        base: `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/v1`,
        name: "Scratch",
        key: null,
      }),
    ),
    Effect.map((answer) => {
      assert.strictEqual(answer.kind, "unavailable");
      assert.match(
        answer.kind === "unavailable" ? answer.message : "",
        /certificate .* isn't trusted/,
      );
    }),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  ),
);
