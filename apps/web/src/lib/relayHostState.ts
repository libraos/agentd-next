import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessReadScope, WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

// This computer's relay host: the relay it uses and the devices paired through it. The server
// keeps the keys; `lnext relay status|devices|revoke` read and change the same state.

const scheduler = createAtomCommandScheduler();

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:relay-host:status",
  tag: WS_METHODS.relayHostStatus,
  staleTimeMs: 10_000,
});

const revokeDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:relay-host:revoke-device",
  tag: WS_METHODS.relayHostRevokeDevice,
  scheduler,
  onSettled: (target, registry) =>
    Effect.sync(() => registry.refresh(status({ environmentId: target.environmentId, input: {} }))),
});

/** Null until the environment's session can read access grants. */
export function useRelayHostStatus(environmentId: EnvironmentId | null) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  return useEnvironmentQuery(
    environmentId === null || !canRead ? null : status({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useRelayHostCommands(environmentId: EnvironmentId | null) {
  return {
    canRevoke: useAtomValue(revokeDevice.permissionAtom(environmentId)),
    // The page says what failed itself, on the device's row.
    revokeDevice: useAtomCommand(revokeDevice, { reportFailure: false }),
  };
}
