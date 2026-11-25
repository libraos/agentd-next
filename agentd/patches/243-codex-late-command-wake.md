# A late Codex command exit wakes the agent only when it was awaited

A Codex command that outlived its turn started a new assistant turn when it exited, even after
the agent had finished the task another way. Codex now supports `background_wait` like Claude:
only a command the agent marked wakes it. Any other late exit only updates its command item in
place, with its exit code and output.

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: report `supportsBackgroundWait`, add `awaitBackgroundTasks` (matches a running root command by process id or item id), offer the late-exit continuation and stamp `completionWake: "always"` only for awaited commands, clear marks on exit and on `thread/closed`.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: cover the unawaited and awaited late exit; the existing wake tests mark their commands first.
- `apps/server/src/provider/CodexDeveloperInstructions.ts`: tell Codex to call `background_wait` for a background command it waits on, only when orchestration tools are on.
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts`: grant `background-wait` only with the task tools; with `enableAgentOrchestrationTools` off a session keeps only preview and device (#6). The credential-reuse check compares against the granted set, so it does not rotate on every open.
- `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts`: the orchestration-on full sets now include `background-wait` (the test adapter is Codex).
- `apps/server/src/provider/CodexDeveloperInstructions.test.ts`: no `background_wait` line without orchestration tools.
- `apps/server/src/provider/agentContextBudget.json`: Codex's additional context grows by the `background_wait` line.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: upstream's "settles a command Codex never completed once its terminal is gone" expects no continuation, since the agent never waited on that command.
