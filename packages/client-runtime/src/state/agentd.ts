import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT } from "./commandOutput.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * agentd on one environment: its status, its tasks and their output, and the commands that start
 * and stop them. agentd keeps the truth; these atoms only read it and ask it to act.
 */
export function createAgentdEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agentd:status",
    tag: WS_METHODS.agentdStatus,
    staleTimeMs: 30_000,
  });
  const task = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agentd:task",
    tag: WS_METHODS.agentdTask,
    staleTimeMs: 5_000,
  });
  const tasks = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:agentd:tasks",
    tag: WS_METHODS.agentdSubscribeTasks,
    idleTtlMs: 0,
  });
  // Approvals have no stream: a change in the task list, such as a worker report, rereads them.
  const approvals = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agentd:approvals",
    tag: WS_METHODS.agentdApprovals,
    staleTimeMs: 5_000,
    refreshTrigger: ({ environmentId }) => tasks({ environmentId, input: {} }),
  });
  const inbox = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agentd:inbox",
    tag: WS_METHODS.agentdInbox,
    staleTimeMs: 5_000,
  });
  const plugins = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agentd:plugins",
    tag: WS_METHODS.agentdPluginsList,
    staleTimeMs: 30_000,
  });
  return {
    status,
    plugins,
    pluginsInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:plugins-install",
      tag: WS_METHODS.agentdPluginsInstall,
      scheduler,
    }),
    pluginsRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:plugins-remove",
      tag: WS_METHODS.agentdPluginsRemove,
      scheduler,
    }),
    pluginsSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:plugins-setup",
      tag: WS_METHODS.agentdPluginsSetup,
      scheduler,
    }),
    pluginsSetSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:plugins-set-settings",
      tag: WS_METHODS.agentdPluginsSetSettings,
      scheduler,
    }),
    pluginsSetEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:plugins-set-enabled",
      tag: WS_METHODS.agentdPluginsSetEnabled,
      scheduler,
    }),
    beforeSendReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:before-send-review",
      tag: WS_METHODS.agentdBeforeSendReview,
      scheduler,
    }),
    beforeSendConfirm: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:before-send-confirm",
      tag: WS_METHODS.agentdBeforeSendConfirm,
      scheduler,
    }),
    beforeSendDiscard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:before-send-discard",
      tag: WS_METHODS.agentdBeforeSendDiscard,
      scheduler,
    }),
    // A thread's placeholders and their originals; it grows only when a review is confirmed.
    placeholders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:placeholders",
      tag: WS_METHODS.agentdPlaceholders,
      staleTimeMs: 30_000,
    }),
    tasks,
    task,
    taskOutput: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agentd:task-output",
      tag: WS_METHODS.agentdSubscribeTaskOutput,
      idleTtlMs: 0,
      transform: (frames) =>
        frames.pipe(Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame)),
    }),
    approvals,
    inbox,
    people: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:people",
      tag: WS_METHODS.agentdPeople,
      staleTimeMs: 30_000,
    }),
    startTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:start-task",
      tag: WS_METHODS.agentdStartTask,
      scheduler,
    }),
    retryStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:retry-start",
      tag: WS_METHODS.agentdRetryStart,
      scheduler,
    }),
    stopTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:stop-task",
      tag: WS_METHODS.agentdStopTask,
      scheduler,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            task({ environmentId: target.environmentId, input: { id: target.input.id } }),
          ),
        ),
    }),
    recheckTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:recheck-task",
      tag: WS_METHODS.agentdRecheckTask,
      scheduler,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            task({ environmentId: target.environmentId, input: { id: target.input.id } }),
          ),
        ),
    }),
    connectAgent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:connect-agent",
      tag: WS_METHODS.agentdConnectAgent,
      scheduler,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(status({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    joinTeam: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:join-team",
      tag: WS_METHODS.agentdJoinTeam,
      scheduler,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(status({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    cloudSetup: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:cloud-setup",
      tag: WS_METHODS.agentdCloudSetup,
      staleTimeMs: 0,
    }),
    // The Usage page's LibraOS account: read when it opens, at most once a minute.
    cloudBalance: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:cloud-balance",
      tag: WS_METHODS.agentdCloudSetup,
      staleTimeMs: 60_000,
    }),
    // The caller refreshes its own cloud setup reads: they are keyed by a working directory.
    cloudConfigure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:cloud-configure",
      tag: WS_METHODS.agentdCloudConfigure,
      scheduler,
    }),
    cloudKeyFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:cloud-key-file",
      tag: WS_METHODS.agentdCloudKeyFile,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    cloudKeyFileFix: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:cloud-key-file-fix",
      tag: WS_METHODS.agentdCloudKeyFileFix,
      scheduler,
    }),
    repairServices: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:repair-services",
      tag: WS_METHODS.agentdRepairServices,
      scheduler,
    }),
    cloudReview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:cloud-review",
      tag: WS_METHODS.agentdCloudReview,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    taskDefaults: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:task-defaults",
      tag: WS_METHODS.agentdTaskDefaults,
      staleTimeMs: 60_000,
    }),
    gitIdentity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:git-identity",
      tag: WS_METHODS.agentdGitIdentity,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    setGitIdentity: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:set-git-identity",
      tag: WS_METHODS.agentdSetGitIdentity,
      scheduler,
    }),
    taskOthers: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:task-others",
      tag: WS_METHODS.agentdTaskOthers,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    teamNode: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agentd:team-node",
      tag: WS_METHODS.agentdSubscribeTeamNode,
      idleTtlMs: 0,
    }),
    setTeamNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:set-team-node",
      tag: WS_METHODS.agentdSetTeamNode,
      scheduler,
    }),
    teamNodeForeground: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:team-node-foreground",
      tag: WS_METHODS.agentdTeamNodeForeground,
      scheduler,
    }),
    workerGateway: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:worker-gateway",
      tag: WS_METHODS.agentdWorkerGateway,
      staleTimeMs: 30_000,
    }),
    setWorkerGateway: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:set-worker-gateway",
      tag: WS_METHODS.agentdSetWorkerGateway,
      scheduler,
    }),
    eula: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:eula",
      tag: WS_METHODS.agentdEula,
      staleTimeMs: 300_000,
    }),
    setup: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agentd:setup",
      tag: WS_METHODS.agentdSubscribeSetup,
      idleTtlMs: 0,
    }),
    setupStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:setup-start",
      tag: WS_METHODS.agentdSetupStart,
      scheduler,
    }),
    permissionMode: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agentd:permission-mode",
      tag: WS_METHODS.agentdPermissionMode,
      staleTimeMs: 30_000,
    }),
    lowerPermissionMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:lower-permission-mode",
      tag: WS_METHODS.agentdLowerPermissionMode,
      scheduler,
    }),
    setMaxWorkers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:set-max-workers",
      tag: WS_METHODS.agentdSetMaxWorkers,
      scheduler,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(status({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    // A backup of this computer's agentd memory, encrypted to the asking device's public key.
    backupCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agentd:backup-create",
      tag: WS_METHODS.agentdBackupCreate,
      scheduler,
    }),
  };
}
