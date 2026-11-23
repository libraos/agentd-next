# Continue a thread while the agent says work remains

The agent ends its final message with a status line ("Status: done", "Status: remaining: ...",
"Status: blocked: ..."). When a turn completes with "remaining", the server starts one more turn in
the same thread, recorded on the run as `autoContinuationOfRunId`. No line means no continuation.
Defaults: on, at most 3 per message the user sends (`continueWhileWorkRemains`,
`maxAutomaticContinuations` in server settings, overridable per project). No settings UI yet.
A continuation goes through the before-send hooks like any send that is not the system's own (its
text quotes the agent's "remaining" words); a block or an unreviewable rewrite stops the chain with
the hook's reason as the run's "Not continued automatically" note.

New files: `apps/server/src/orchestration-v2/AutoContinuationReactor.ts` (+ test),
`packages/shared/src/orchestrationV2AutoContinuation.ts` (+ test).

- `packages/contracts/src/orchestrationV2.ts` — `autoContinuationOfRunId` on runs and `message.dispatch`.
- `packages/contracts/src/settings.ts` — the two settings, global and project-scoped.
- `packages/shared/package.json` — export the new shared module.
- `packages/provider-core/src/server/runtimeInstructions.ts` — ask every harness for the status line.
- `packages/provider-core/src/server/runtimeInstructions.test.ts` — assert the status line is asked for.
- `apps/server/src/orchestration-v2/Orchestrator.ts` — copy the field onto runs, refuse a continuation that is stale or changes provider or model, let it carry its notice, and add `noteRunSystemNotice` for the "not continued" note.
- `apps/server/src/server.ts` — start the reactor, with the plugin service its before-send check reads.
- `apps/server/src/provider/agentContextBudget.json` — the measured size with the status-line instructions.
