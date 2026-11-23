import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

// Gateways added by URL on one environment. The server keeps their keys; clients see hasKey.

const scheduler = createAtomCommandScheduler();

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:custom-gateway:list",
  tag: WS_METHODS.customGatewayList,
  staleTimeMs: 60_000,
});

const refreshList = (
  target: { readonly environmentId: EnvironmentId },
  registry: { readonly refresh: (atom: ReturnType<typeof list>) => void },
) => Effect.sync(() => registry.refresh(list({ environmentId: target.environmentId, input: {} })));

const customGatewayEnvironment = {
  add: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:custom-gateway:add",
    tag: WS_METHODS.customGatewayAdd,
    scheduler,
    onSettled: refreshList,
  }),
  rename: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:custom-gateway:rename",
    tag: WS_METHODS.customGatewayRename,
    scheduler,
    onSettled: refreshList,
  }),
  setHiddenModels: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:custom-gateway:set-hidden-models",
    tag: WS_METHODS.customGatewaySetHiddenModels,
    scheduler,
    onSettled: refreshList,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:custom-gateway:remove",
    tag: WS_METHODS.customGatewayRemove,
    scheduler,
    onSettled: refreshList,
  }),
};

export function useCustomGateways(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : list({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useCustomGatewayCommands(environmentId: EnvironmentId | null) {
  const canChange = useAtomValue(customGatewayEnvironment.add.permissionAtom(environmentId));
  // The form and the list say what failed themselves, beside the field.
  const options = { reportFailure: false } as const;
  return {
    canChange,
    add: useAtomCommand(customGatewayEnvironment.add, options),
    rename: useAtomCommand(customGatewayEnvironment.rename, options),
    setHiddenModels: useAtomCommand(customGatewayEnvironment.setHiddenModels, options),
    remove: useAtomCommand(customGatewayEnvironment.remove, options),
  };
}
