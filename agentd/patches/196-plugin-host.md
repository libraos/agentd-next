# 196 — Plugin host with a before-send hook

A plugin is a folder from our catalogue (`libraos/plugins`, `catalog.json`), pinned to one commit and checked file by file against the git tree the same way Skills are. Its `agentd-plugin.json` declares hooks. The one hook event is `before-send`: the app server runs the hook's command with one JSON object on stdin (`{version, event, message: {text, attachments}, context: {projectId, threadId, source}}`) and reads one JSON object from stdout: `pass`, `rewrite` (new text and new text for UTF-8 attachments it was shown) or `block` with a reason. Each version is installed under `<stateDir>/plugins/cache/libraos/<plugin>/<version>/` with `.agentd-plugin-install.json` listing every file the install wrote; remove deletes only those. Whether a plugin is on is a setting for the environment (`<stateDir>/plugins/settings.json`) with a per-project override.

Enabled hooks run in id order before a send is committed, each on the previous hook's output. A block, a timeout (10 s by default, at most 60), a non-zero exit, output that is not exactly one decision, or a hook command that is no longer there stops the send and returns a reason that names the plugin. A rewrite of a message a person typed in web or desktop is held on the server and the client opens a review: the person sends it as shown, edits it, or closes it and keeps their draft. Confirm sends the held command again, with the confirmed content, through the same intake, and the hooks do not run again. A rewrite of a message nobody can review (MCP, scheduled tasks, agents, mobile for now) stops the send. With no plugin on, no hook runs and nothing about sending changes. Message text, hook stdout and hook stderr are never logged or put on spans.

Ours (no upstream counterpart):

- `packages/contracts/src/agentdPlugins.ts`: listing, inputs, review and the two errors.
- `apps/server/src/agentd/pluginCatalog.ts` (+ test): catalogue, manifest, install record, settings, the hook's stdin and its parsed output, and hook command resolution (a file in the plugin's folder, or a program on PATH).
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): install, remove, enable, list, running the hooks, the held reviews (in memory, 15 minutes, one per message).
- `apps/server/src/agentd/beforeSendGate.ts`: where sends meet the hooks. It runs once in the intake for a client's send (it can be reviewed) and again in `ThreadManagementService.dispatch` as a backstop for everything else (it cannot be reviewed). It skips re-dispatches of stored messages, receipt replays, guest messages until their text is known, and the server's own continuations.
- `apps/server/src/agentd/beforeSendConfirm.ts`: sends a confirmed message through the intake.
- `apps/server/src/agentd/AgentdSkills.ts`, `skillCatalog.ts`: the pinned download and file plan are shared with plugins.
- `packages/client-runtime/src/state/agentd.ts`, `apps/web/src/lib/agentdState.ts`: plugin atoms and hooks.
- `apps/web/src/components/agentd/AgentdPagePlugins.tsx`, `AgentdPage.tsx`: the Plugins section (install, update, on/off, remove).
- `apps/web/src/components/agentd/BeforeSendControls.tsx` (+ browser test), `beforeSendReviewStore.ts`: the indicator beside Send and the review dialog.

Upstream files:

- `packages/contracts/src/rpc.ts`: seven `agentd.*` plugin and review RPCs.
- `packages/contracts/src/index.ts`: export the new contract.
- `packages/contracts/src/clientRpcPermissions.ts`: install, remove and enable need environment maintain; confirm and discard need orchestration operate.
- `apps/server/src/auth/RpcAuthorization.ts`: list and review need orchestration read.
- `apps/server/src/observability/RpcInstrumentation.ts`: the new methods count as `agentd`.
- `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`: run the gate before attachments are claimed, for `dispatchCommand` and `launchThread`.
- `apps/server/src/orchestration-v2/ThreadManagementService.ts`: run the backstop gate before `orchestrator.dispatch`.
- `apps/server/src/ws.ts`: the RPC handlers; a launch's before-send error maps to the launch error.
- `apps/server/src/server.ts`: provide the plugin service to the RPC layer and the orchestration runtime (one shared value).
- `apps/server/src/ws.test.ts`: mock the plugin service.
- `apps/server/src/orchestration-v2/SteeringCompletion.integration.test.ts`: a blocked send reaches no provider; a confirmed rewrite is what is stored and what the adapter receives.
- `apps/web/src/components/chat/ChatComposer.tsx`: render `BeforeSendControls` beside Send.
- `apps/web/src/components/chat/useComposerSend.ts`: after a failed send, ask for a held review; a confirmed send clears the restored draft.
- `apps/web/src/i18n/translations/*.json`: the new text in every locale.

Not done: the `libraos/plugins` catalogue repository does not exist yet, so the list is empty until it does. Mobile shows the reason but has no review dialog. A queued message edited in the web composer gets the reason but no review dialog. The per-project override has an RPC but no control on the page yet. Composer context records (terminal output and the like) are not shown to hooks. Tested on Linux only; hook commands are run without a shell, so a Windows plugin needs a `.exe` or a program on PATH.
