# Offer a worker for the work a turn leaves, and suggest a local worker limit

Both are suggestions; nothing starts or changes without the person's click.

**Remaining work.** When the thread's latest turn ends with the #204 status line "Status: remaining:
…" (`parseCompletionStatus`, see [204-auto-continuation.md](204-auto-continuation.md)) and the thread
is idle, the turn's final message shows Run locally / Run in cloud / Keep in chat. Run locally and Run
in cloud open the existing Hand to a worker dialog with the remaining work as the goal, set to run on
this machine or in Cloud Workers, and the suggested check still fills the empty check; the person
reviews it and presses Start, which the dialog's Background workers readiness check (#220,
[220-background-workers-readiness.md](220-background-workers-readiness.md)) holds as for any task.
Run in cloud shows only while the LibraOS account is linked for Cloud Workers. Keep in chat hides
the offer for that turn. The offer needs LibraOS Engine set up, a connection that can start tasks,
a working directory, and Settings → Workers → Suggest workers on.
Older turns, a running turn and a turn waiting on the person never show it. An automatic continuation
starts a newer turn, so the offer moves to wherever the chain stops. Mobile has no Hand to a worker
yet, so the offer is web and desktop only.

**Local worker limit.** Settings → Workers gains "Local workers at once", agentd's
`dispatch.max_workers`, editable (1–64), shown when agentd reports the setting. Beside it is a
suggestion from the CPU count of the machine the workers run on (the server's
`os.availableParallelism()`, so it is right over a remote connection): `max(1, floor(cores / 4))`,
capped at 64. "Use N" applies it; it is never applied on its own. Setting it needs the environment
maintain scope, as other writes to agentd's config do.

New files: `apps/web/src/components/agentd/RemainingWorkOffer.tsx`,
`apps/web/src/components/agentd/LocalWorkerLimitRow.tsx`.

- `packages/contracts/src/agentd.ts` — `cpuCount` on the status, `AgentdSetMaxWorkersInput`.
- `packages/contracts/src/rpc.ts` — the `agentd.setMaxWorkers` method.
- `packages/contracts/src/clientRpcPermissions.ts` — it needs the environment maintain scope.
- `packages/client-runtime/src/state/agentd.ts` — the command, refreshing the status after it.
- `apps/server/src/agentd/agentdCommands.ts` — `config set dispatch.max_workers N`.
- `apps/server/src/agentd/AgentdBridge.ts` (+ test) — `setMaxWorkers`, and the CPU count on the status.
- `apps/server/src/ws.ts`, `apps/server/src/observability/RpcInstrumentation.ts` — route and label the method.
- `apps/server/src/auth/RpcAuthorization.test.ts` — assert its scope.
- `apps/web/src/lib/agentdState.ts` — expose the command.
- `apps/web/src/components/agentd/agentdVisibility.logic.ts` (+ test) — when the offer shows, the suggested limit, and reading a typed limit.
- `apps/web/src/components/agentd/StartTaskDialog.tsx`, `StartTaskCloud.tsx` — open Hand to a worker set to run locally or in the cloud, with the check left to the suggestion.
- `apps/web/src/components/agentd/WorkersSettings.tsx` — the limit row.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx` — the offer under the turn's final message.
- `apps/web/src/i18n/translations/*.json` — the new text in every language.
- `docs/user/workers.md` — the offer and the limit, in a sentence each.
