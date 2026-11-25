# #78: Hand-off fixes from the Windows newcomer test

## 7. Git identity

- `apps/server/src/agentd/AgentdBridge.ts` (ours): `gitIdentity` reads `git config --get user.name` and `user.email` in the task's folder; `setGitIdentity` writes them with `git config --global -- <key> <value>`. Both are argument lists through the process runner, whose resolver finds `git.exe` on Windows; no shell and no paths built by hand.
- `packages/contracts/src/agentd.ts` (ours): the inputs and result; a name or email is one line of at most 200 characters.
- `packages/contracts/src/rpc.ts` (upstream): the `agentd.gitIdentity` and `agentd.setGitIdentity` methods.
- `packages/contracts/src/clientRpcPermissions.ts` (upstream): setting needs `environment:maintain`, as other edits to this host's config do.
- `apps/server/src/auth/RpcAuthorization.ts` (upstream): reading needs `orchestration:read`, as the task defaults do.
- `apps/server/src/ws.ts` (upstream): one handler line for each.
- `apps/server/src/observability/RpcInstrumentation.ts` (upstream): their `agentd` group.
- `packages/client-runtime/src/state/agentd.ts` (upstream): the query and the command.
- `apps/web/src/lib/agentdState.ts` (ours): `useAgentdGitIdentity` and `setGitIdentity` in `useAgentdCommands`.
- `apps/web/src/components/agentd/startTask.logic.ts`, `taskPlan.tsx` (ours): a missing name or email is a start problem of a local task, listed under Still needed; a cloud task commits as its own account and skips it.
- `apps/web/src/components/agentd/GitIdentitySetup.tsx`, `StartTaskDialog.tsx` (ours): the dialog shows the two fields and Save, then reads the identity again. The task card in the chat says what is missing; its Edit opens the dialog.

The Git commands are the same on Windows; it was not run there. The value is read in the task's folder, so a repository's own `user.name` counts, and saved globally, so it holds for every repository of the user the server runs as.

## 8. Findable

- `apps/web/src/components/chat/ThreadDetailsAgentdWorkers.tsx` (ours): a lasting "Hand to a worker" row in the session panel's workers section opens the Hand to a worker dialog, shown only when the environment allows starting a task.
- `packages/client-runtime/src/providerSkills.ts` (upstream): the `/` menu hides the bundled `agentd` and `agentd-setup` skills, and provider commands of the same names, so the dialog is their one entry. Web and mobile both read this helper.
- `packages/client-runtime/src/providerSkills.test.ts` (upstream): a row for the hidden names, with another skill still shown.

The button reuses the existing "Hand to a worker" string, so no new translation key. The change is web UI and a pure filter with no paths or processes, so it is the same on Windows and Linux; it was not run on Windows.

## 15. Status of a stuck task

- `apps/web/src/components/agentd/AgentdBackgroundTaskRow.tsx` (ours): a Waiting task whose worker exited or whose check failed shows its check result and the worker's latest report, and a Re-run check action beside Stop, hidden without the permission. Stop stays the way to close it.
- `apps/web/src/components/agentd/backgroundTasks.logic.ts` (ours): `isStuckAgentdTask`; a check that timed out in agentd's worker wording ("timed out after …") also counts as failed.
- `apps/server/src/agentd/agentdCommands.ts`, `AgentdBridge.ts` (ours): `handoff recheck <id>` as a fixed argument list; the call waits for the check, up to an hour.
- `apps/server/src/agentd/agentdJson.ts`, `packages/contracts/src/agentd.ts` (ours): agentd's verdict names a check only once a task is done, so an unfinished task's check result falls back to its latest worker run (`results[].check_result`).
- `packages/contracts/src/rpc.ts` (upstream): the `agentd.recheckTask` method.
- `packages/contracts/src/clientRpcPermissions.ts` (upstream): it needs `orchestration:operate`, as Stop does; a check is a command run on this host.
- `apps/server/src/ws.ts` (upstream): one handler line calling the bridge.
- `apps/server/src/observability/RpcInstrumentation.ts` (upstream): the method's `agentd` group.
- `packages/client-runtime/src/state/agentd.ts` (upstream): the command, refreshing the task when it settles.
- `apps/web/src/lib/agentdState.ts` (ours): `recheckTask` in `useAgentdCommands`, without a toast: the card shows a failed run inline.

agentd lets the task's sender session or an owner re-run a check; the app runs it with no session, so it acts as the person at this host (an owner, or the only person on a ledger without users). Stop's cancel was not tested against a real agentd here (a sandbox ledger needs the EULA accepted at a terminal), so `--session` was not added to it; agentd's code suggests a cancel with no session is refused unless it is the sender's.
