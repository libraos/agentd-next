# 205: Set-up asks how much background workers may do without asking

At first setup (agentd's doctor says there is no `config.toml` yet) the **Set up AgentD** dialog asks "How much may background workers do without asking?" with **Ask first** and **Run without asking**, neither selected; **Accept and set up** stays disabled until one is chosen. The server passes the choice to `agentd init --permission-mode guarded|yolo` (agentd-core#1021) when that agentd's `init --help` names the flag, and refuses a first setup without a choice. An agentd without the flag runs init as before and the dialog says the choice was not taken. An installed agentd taking a new agreement is not asked: agentd refuses the flag once a config exists.

The app keeps no copy of the mode. **Settings → Workers → AgentD** reads it from agentd (`agentd config get dispatch.permission_mode`, `..._roles`, `..._repos`, each `--json`). **Ask first** runs `agentd config set dispatch.permission_mode guarded` as an ordinary child process, the value fixed in code, and reads the mode back. **Run without asking** only shows `agentd config set dispatch.permission_mode yolo` to run in a terminal, since agentd takes raising only from a person there. A role or repository set to yolo is named in the row.

A background task whose worker is blocked (`worker_state` `blocked`: a permission prompt or a question in its tool) shows what it waits for (`worker_wait`) and, for a Claude worker, the `claude attach <id>` command, the id read from the top of the worker's log; other workers point to their own session or AgentD's Inbox.

New, ours:

- `apps/server/src/agentd/permissionMode.ts`, `permissionMode.test.ts`: reading the mode from `config get`, the flag in init's help, the attach command.
- `apps/web/src/components/agentd/WorkerPermissionMode.tsx`, `WorkerPermissionMode.browser.test.tsx`: the set-up question, the Settings row, the waiting notice.

Upstream files changed (fewest lines):

- `packages/contracts/src/rpc.ts`: `agentd.permissionMode` and `agentd.lowerPermissionMode` with their RPCs; `agentd.setupStart` takes `AgentdSetupStartInput`.
- `packages/contracts/src/clientRpcPermissions.ts`: `agentd.lowerPermissionMode` needs `AuthEnvironmentMaintainScope` (it writes agentd's config on the host).
- `apps/server/src/auth/RpcAuthorization.ts`: read scope for `agentd.permissionMode`.
- `apps/server/src/observability/RpcInstrumentation.ts`: the two methods under `agentd`.
- `apps/server/src/ws.ts`: `agentd.setupStart` passes its input; two handlers, each one service call.
- `apps/web/src/i18n/translations/*.json`: the new strings, translated in every locale.

Shared files (entries added, fewest lines):

- `packages/contracts/src/agentd.ts`: `AgentdPermissionMode`, `AgentdSetupStartInput`, `AgentdPermissionModeState`; `AgentdStatus.firstSetup`; `AgentdSetupState.permissionModeIgnored`; `AgentdTask.waitingFor`, `attachCommand`; `worker_wait` in the `handoff show` schema.
- `apps/server/src/agentd/agentdCommands.ts`: `init` takes the mode; `lowerPermissionMode`; three `configGet` keys.
- `apps/server/src/agentd/agentdInit.ts`: init flags read once per agentd version; the mode passed or refused.
- `apps/server/src/agentd/AgentdBridge.ts`: `permissionMode`, `lowerPermissionMode`; `task` adds the attach command for a blocked Claude worker.
- `apps/server/src/agentd/agentdJson.ts`: `firstSetup` from doctor's config check; `waitingFor`.
- `packages/client-runtime/src/state/agentd.ts`: `permissionMode`, `lowerPermissionMode` atoms.
- `apps/web/src/lib/agentdState.ts`: `useAgentdPermissionMode`, `lowerPermissionMode` command.
- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: the question at first setup.
- `apps/web/src/components/agentd/WorkersSettings.tsx`: the row in the AgentD section once set up.
- `apps/web/src/components/agentd/AgentdBackgroundTaskRow.tsx`, `AgentdPage.tsx`: the waiting notice on a blocked task.

Needs an agentd release with agentd-core#1021 (the init flag) and its follow-up that lets `config set dispatch.permission_mode guarded` run without a terminal; until then Ask first in Settings shows agentd's refusal. Mobile has no AgentD page or worker settings, so it does not show the mode yet.
