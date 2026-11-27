import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerActivation from "../../serverActivation.ts";
import { loopbackUrlHostForAddress } from "../../startupAccess.ts";
import { startRelayHost } from "./relayHost.ts";

/**
 * Runs the relay host for as long as the server serves. It idles until `relay connect` stores a
 * relay, so a server never connects to one unless asked; a policy without remote clients turns it off.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!ManagedLimits.allowsRemoteClients(yield* ManagedPolicy.ManagedPolicy)) return;
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) return;
    const target = { host: loopbackUrlHostForAddress(address), port: address.port };
    // Parked until activation, so a standby server does not take over the relay's control socket.
    yield* ServerActivation.forkParked(
      Effect.gen(function* () {
        const runFork = Effect.runForkWith(yield* Effect.context<never>());
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            startRelayHost({
              stateDir: config.stateDir,
              target,
              log: (level, message, fields) =>
                void runFork(
                  level === "info"
                    ? Effect.logInfo(message, fields ?? {})
                    : Effect.logWarning(message, fields ?? {}),
                ),
            }),
          ),
          (host) => Effect.promise(() => host.stop()),
        );
        return yield* Effect.never;
      }),
    );
  }),
).pipe(Layer.provide(ManagedPolicy.layer));
