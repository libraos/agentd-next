import { RelayHostError, type RelayHostStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readRelayOverview, revokeRelayDevice } from "./relayDevices.ts";

const tryRelay = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RelayHostError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

/** Settings → Relay: the same reads and revoke as `lnext relay status|devices|revoke`. */
export const makeRelayHostRpc = (stateDir: string) => {
  const status = Effect.fn("RelayHost.status")(function* () {
    const overview = yield* tryRelay(() => readRelayOverview(stateDir));
    return {
      relay:
        overview.relay === null
          ? null
          : {
              relayUrl: overview.relay.relayUrl,
              hostId: overview.relay.hostId,
              online: overview.relay.online,
            },
      devices: overview.devices,
    } satisfies RelayHostStatus;
  });
  const revokeDevice = Effect.fn("RelayHost.revokeDevice")(function* (deviceId: string) {
    const result = yield* tryRelay(() => revokeRelayDevice(stateDir, deviceId));
    return {
      keyRemoved: result.keyRemoved,
      relayFailure: result.atRelay.kind === "failed" ? result.atRelay.message : null,
      status: yield* status(),
    };
  });
  return { status, revokeDevice };
};
