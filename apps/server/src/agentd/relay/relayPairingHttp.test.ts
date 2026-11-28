// @effect-diagnostics nodeBuiltinImport:off - a scratch state directory and the test relay on real sockets.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { loadOrCreateHostKey, toBase64Url, writeRelayConfig } from "./relayStore.ts";
import { startTestRelay, TEST_HOST_ID, TEST_HOST_TOKEN } from "./testRelay.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
const ORIGIN = "http://127.0.0.1:50029";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

/** The auth routes a phone pairs through, with relay state kept in `stateDir`. */
const makeAuthRoutes = (stateDir: string) => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        stateDir,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "relay-pairing-http-" })));
  return HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    ),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const post = (
  path: string,
  init: { headers?: Record<string, string>; body: string | URLSearchParams },
) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: new URL(ORIGIN).host, ...init.headers },
    body: init.body,
  });

const tokenExchange = (credential: string, dpop?: string) =>
  post("/oauth/token", {
    ...(dpop === undefined ? {} : { headers: { dpop } }),
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      client_label: "iPhone",
      client_device_type: "mobile",
      client_os: "iOS",
    }),
  });

// The web handler runs on its own runtime, so DPoP proofs need wall-clock time.
it.live.each([
  { relay: "off" as const, proof: "DPoP" as const },
  { relay: "off" as const, proof: "bearer" as const },
  { relay: "on" as const, proof: "DPoP" as const },
  { relay: "on" as const, proof: "bearer" as const },
])("a phone pairs with a link made in Settings, relay $relay, $proof", ({ relay, proof }) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.promise(async () => {
        const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-pairing-"));
        const testRelay = relay === "on" ? await startTestRelay() : undefined;
        if (testRelay !== undefined) {
          await writeRelayConfig(stateDir, {
            relayUrl: testRelay.url,
            token: TEST_HOST_TOKEN,
            hostId: TEST_HOST_ID,
          });
        }
        return {
          stateDir,
          testRelay,
          environment: HttpRouter.toWebHandler(makeAuthRoutes(stateDir), { disableLogger: true }),
        };
      }),
      ({ stateDir, testRelay, environment }) =>
        Effect.promise(async () => {
          const browser = await environment.handler(
            post("/api/auth/browser-session", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ credential: DEV_TOKEN }),
            }),
            requestContext,
          );
          const cookie = browser.headers
            .getSetCookie()
            .find((entry) => entry.startsWith("t3_dev_session_"))!
            .split(";", 1)[0]!;

          const created = await environment.handler(
            post("/api/auth/pairing-token", {
              headers: { "content-type": "application/json", cookie },
              body: JSON.stringify({ label: "My phone" }),
            }),
            requestContext,
          );
          expect(created.status).toBe(200);
          const issued = (await created.json()) as { credential: string; relay?: unknown };
          if (testRelay === undefined) {
            expect(issued).not.toHaveProperty("relay");
          } else {
            const hostKey = await loadOrCreateHostKey(stateDir);
            expect(issued.relay).toMatchObject({
              relayUrl: testRelay.url,
              hostId: TEST_HOST_ID,
              hostKey: toBase64Url(hostKey.publicKey),
              deviceToken: expect.any(String),
            });
          }

          const key = makeDpopKey();
          const exchanged = await environment.handler(
            tokenExchange(
              issued.credential,
              proof === "DPoP"
                ? key.sign({ method: "POST", url: `${ORIGIN}/oauth/token`, token: "", iat })
                : undefined,
            ),
            requestContext,
          );
          expect(exchanged.status).toBe(200);
          expect(await exchanged.json()).toMatchObject({
            access_token: expect.any(String),
            token_type: proof === "DPoP" ? "DPoP" : "Bearer",
            issued_token_type: AuthAccessTokenType,
          });

          const spent = await environment.handler(tokenExchange(issued.credential), requestContext);
          expect(spent.status).toBe(401);
        }),
      ({ stateDir, testRelay, environment }) =>
        Effect.promise(async () => {
          await environment.dispose();
          await testRelay?.close();
          await NodeFSP.rm(stateDir, { recursive: true, force: true });
        }),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
