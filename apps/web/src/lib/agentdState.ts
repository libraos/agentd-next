import { createAgentdEnvironmentAtoms } from "@t3tools/client-runtime/state/agentd";
import {
  AuthOrchestrationReadScope,
  type AgentdHandoffId,
  type AgentdTaskOthersInput,
  type AgentdTaskSize,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** agentd's atoms; read `permissionAtom` on a command to decide whether to offer it. */
export const agentdEnvironment = createAgentdEnvironmentAtoms(connectionAtomRuntime);

// The primary environment unless one is named; null when it cannot read agentd.
function useAgentdEnvironment(target: EnvironmentId | null | undefined): EnvironmentId | null {
  const primary = usePrimaryEnvironment();
  const environmentId = target === undefined ? (primary?.environmentId ?? null) : target;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? environmentId : null;
}

export function useAgentdStatus(target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.status({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useAgentdTasks(target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.tasks({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useAgentdTask(id: AgentdHandoffId | null, target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || id === null
      ? null
      : agentdEnvironment.task({ environmentId, input: { id } }),
    useMessages(),
  );
}

/** The task's worker log tail while it runs, as a command output view. */
export function useAgentdTaskOutput(id: AgentdHandoffId | null, target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || id === null
      ? null
      : agentdEnvironment.taskOutput({ environmentId, input: { id } }),
    useMessages(),
  );
}

export function useAgentdApprovals(target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.approvals({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useAgentdInbox(target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.inbox({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useAgentdPeople(target?: EnvironmentId | null, includeNodes = false) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : agentdEnvironment.people({ environmentId, input: includeNodes ? { includeNodes } : {} }),
    useMessages(),
  );
}

export function useAgentdTeamNode(target?: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.teamNode({ environmentId, input: {} }),
    useMessages(),
  );
}

export function useAgentdEula(target: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.eula({ environmentId, input: {} }),
    useMessages(),
  );
}

/** Which gateway and model this machine's workers use. */
export function useAgentdWorkerGateway(target: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.workerGateway({ environmentId, input: {} }),
    useMessages(),
  );
}

/** The environment's `agentd init` run: its phase and output. */
export function useAgentdSetup(target: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.setup({ environmentId, input: {} }),
    useMessages(),
  );
}

/** The worker permission mode as agentd holds it; the app keeps no copy. */
export function useAgentdPermissionMode(target: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null ? null : agentdEnvironment.permissionMode({ environmentId, input: {} }),
    useMessages(),
  );
}

/** Each takes `{ environmentId, input }`; failures are reported like any other command's. */
export function useAgentdCommands() {
  return {
    startTask: useAtomCommand(agentdEnvironment.startTask),
    stopTask: useAtomCommand(agentdEnvironment.stopTask),
    connectAgent: useAtomCommand(agentdEnvironment.connectAgent),
    joinTeam: useAtomCommand(agentdEnvironment.joinTeam),
    setTeamNode: useAtomCommand(agentdEnvironment.setTeamNode),
    cloudConfigure: useAtomCommand(agentdEnvironment.cloudConfigure),
    cloudKeyFileFix: useAtomCommand(agentdEnvironment.cloudKeyFileFix),
    repairServices: useAtomCommand(agentdEnvironment.repairServices),
    setWorkerGateway: useAtomCommand(agentdEnvironment.setWorkerGateway, { reportFailure: false }),
    lowerPermissionMode: useAtomCommand(agentdEnvironment.lowerPermissionMode, {
      reportFailure: false,
    }),
  };
}

/** The catalogue's plugins and, for the project named, whether a send runs a before-send hook. */
export function useAgentdPlugins(target: EnvironmentId | null, projectId?: ProjectId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : agentdEnvironment.plugins({
          environmentId,
          input: projectId === null || projectId === undefined ? {} : { projectId },
        }),
    useMessages(),
  );
}

/** Each fails with a message the caller shows beside the plugin or in the review. */
export function useAgentdPluginCommands() {
  const quiet = { reportFailure: false } as const;
  return {
    install: useAtomCommand(agentdEnvironment.pluginsInstall, quiet),
    remove: useAtomCommand(agentdEnvironment.pluginsRemove, quiet),
    setEnabled: useAtomCommand(agentdEnvironment.pluginsSetEnabled, quiet),
    review: useAtomCommand(agentdEnvironment.beforeSendReview, quiet),
    confirm: useAtomCommand(agentdEnvironment.beforeSendConfirm, quiet),
    discard: useAtomCommand(agentdEnvironment.beforeSendDiscard, quiet),
  };
}

/** The Cloud Workers account alone, with no project: balance, setup and plans. */
export function useAgentdCloudAccount(target: EnvironmentId | null) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : agentdEnvironment.cloudSetup({ environmentId, input: { cwd: null, includeBalance: true } }),
    useMessages(),
  );
}

/** The cloud account for the Usage page, through the primary environment's agentd. */
export function useAgentdCloudBalance() {
  const environmentId = useAgentdEnvironment(undefined);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : agentdEnvironment.cloudBalance({
          environmentId,
          input: { cwd: null, includeBalance: true },
        }),
    useMessages(),
  );
  return { environmentId, data: query.data, dataUpdatedAt: query.dataUpdatedAt };
}

export function useAgentdCloudSetup(
  cwd: string | null,
  target: EnvironmentId,
  includeBalance: boolean,
) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || cwd === null
      ? null
      : agentdEnvironment.cloudSetup({ environmentId, input: { cwd, includeBalance } }),
    useMessages(),
  );
}

/** Whose key a chosen Cloud Workers key file holds, and whether others can read it. */
export function useAgentdCloudKeyFile(path: string | null, target: EnvironmentId) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || path === null
      ? null
      : agentdEnvironment.cloudKeyFile({ environmentId, input: { path } }),
    useMessages(),
  );
}

/** agentd's estimate for a task of this size and a check suggested from the project's files. */
export function useAgentdTaskDefaults(
  cwd: string | null,
  target: EnvironmentId,
  size: AgentdTaskSize,
) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || cwd === null
      ? null
      : agentdEnvironment.taskDefaults({ environmentId, input: { cwd, size } }),
    useMessages(),
  );
}

export function useAgentdTaskOthers(input: AgentdTaskOthersInput | null, target: EnvironmentId) {
  const environmentId = useAgentdEnvironment(target);
  return useEnvironmentQuery(
    environmentId === null || input === null
      ? null
      : agentdEnvironment.taskOthers({ environmentId, input }),
    useMessages(),
  );
}
