import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  mcpClientScopes,
} from "./auth.ts";
import { PeerLinkLinkPairingInput } from "./peerLink.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  // The server runs an approved layout command: approving one is running code there, as a terminal does.
  [WS_METHODS.workspaceApproveLayoutCommands]: AuthTerminalOperateScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  // agentd tasks start and stop agent workers on this host, as threads do.
  [WS_METHODS.agentdStartTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentdRetryStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentdStopTask]: AuthOrchestrationOperateScope,
  // A check is a command agentd runs in the task's folder on this host.
  [WS_METHODS.agentdRecheckTask]: AuthOrchestrationOperateScope,
  // Setting the Git identity writes the global Git config of the user the server runs as.
  [WS_METHODS.agentdSetGitIdentity]: AuthEnvironmentMaintainScope,
  // Connecting an agent edits its config on this host; joining a team links the host to a server.
  [WS_METHODS.agentdConnectAgent]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdJoinTeam]: AuthEnvironmentMaintainScope,
  // A backup holds all of agentd's ledger, which filesystem:read can already read, encrypted to
  // a key the caller names: so only a caller that may read every file may ask for one.
  [WS_METHODS.agentdBackupCreate]: AuthFilesystemReadScope,
  // Cloud setup writes agentd's account key and [cloud] settings on this host.
  [WS_METHODS.agentdCloudConfigure]: AuthEnvironmentMaintainScope,
  // Making a key file private changes a mode anywhere the server user can, not only in a workspace.
  [WS_METHODS.agentdCloudKeyFileFix]: AuthEnvironmentMaintainScope,
  // Repair rewrites agentd's services on this host with this app's agentd install.
  [WS_METHODS.agentdRepairServices]: AuthEnvironmentMaintainScope,
  // Working for the team runs agents on this host for the team server.
  [WS_METHODS.agentdSetTeamNode]: AuthEnvironmentMaintainScope,
  // Setting agentd up accepts its EULA and writes its services on this host.
  [WS_METHODS.agentdSetupStart]: AuthEnvironmentMaintainScope,
  // Lowering the worker permission mode writes agentd's config on this host.
  [WS_METHODS.agentdLowerPermissionMode]: AuthEnvironmentMaintainScope,
  // The local worker limit is agentd's config on this host.
  [WS_METHODS.agentdSetMaxWorkers]: AuthEnvironmentMaintainScope,
  // Which gateway and model every local worker sends its requests to is agentd's config on this host.
  [WS_METHODS.agentdSetWorkerGateway]: AuthEnvironmentMaintainScope,
  // Skills are written into, and removed from, the agents' Skills folders on this host.
  [WS_METHODS.agentdSkillsInstall]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdSkillsRemove]: AuthEnvironmentMaintainScope,
  // Plugins install under the server's state and their hooks run on every send here.
  [WS_METHODS.agentdPluginsInstall]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsRemove]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsSetEnabled]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsSetup]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsSetSettings]: AuthEnvironmentMaintainScope,
  // A listing names the files and commands of the host's agents; adding writes a command to run.
  [WS_METHODS.agentdCustomizeConnectorSetEnabled]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdCustomizeConnectorAdd]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdCustomizeConnectorRemove]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdCustomizeSkillSetEnabled]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsAddSource]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsRemoveSource]: AuthEnvironmentMaintainScope,
  // Developer mode runs a folder on this host as a plugin.
  [WS_METHODS.agentdPluginsSetDeveloperMode]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdPluginsAddLocal]: AuthEnvironmentMaintainScope,
  [WS_METHODS.agentdBeforeSendConfirm]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentdBeforeSendDiscard]: AuthOrchestrationOperateScope,
  // The Gateway key goes to this host's agentd and its agents' sessions.
  [WS_METHODS.libraosGatewayConnect]: AuthEnvironmentMaintainScope,
  [WS_METHODS.libraosGatewayDisconnect]: AuthEnvironmentMaintainScope,
  // A custom gateway's key goes to this host's agents' sessions, as the Gateway key does.
  [WS_METHODS.customGatewayAdd]: AuthEnvironmentMaintainScope,
  [WS_METHODS.customGatewayRename]: AuthEnvironmentMaintainScope,
  [WS_METHODS.customGatewaySetHiddenModels]: AuthEnvironmentMaintainScope,
  [WS_METHODS.customGatewayRemove]: AuthEnvironmentMaintainScope,
  [WS_METHODS.customGatewayRefreshModels]: AuthEnvironmentMaintainScope,
  [WS_METHODS.libraosGatewaySignInStart]: AuthEnvironmentMaintainScope,
  [WS_METHODS.libraosGatewaySignInWait]: AuthEnvironmentMaintainScope,
  [WS_METHODS.libraosGatewaySignInCancel]: AuthEnvironmentMaintainScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairClient]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairLink]: AuthAccessWriteScope,
  // Send stores and sends a report from a thread's turn: the bar of running that thread.
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeLinkPairing = Schema.decodeUnknownSync(PeerLinkLinkPairingInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // Handing out access takes holding it: the caller gets back a credential it can spend itself.
  if (method === WS_METHODS.peerLinksPairLink && input !== undefined) {
    const held = mcpClientScopes(decodeLinkPairing(input).access);
    return [AuthAccessWriteScope, ...held];
  }
  if (method === WS_METHODS.guestShareCreate) {
    return [AuthAccessWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
