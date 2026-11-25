# #78: Hand-off fixes from the Windows newcomer test

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

agentd lets the task's sender session or an owner re-run a check; the app runs it with no session, so it acts as the person at this host (an owner, or the only person on a ledger without users). Stop's cancel was not tested against a real agentd here, so `--session` was not added to it.
