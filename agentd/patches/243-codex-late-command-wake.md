# A late Codex command exit wakes the agent only when it was awaited

A Codex command that outlived its turn started a new assistant turn when it exited, even after
the agent had finished the task another way. Codex now supports `background_wait` like Claude:
only a command the agent marked wakes it. Any other late exit only updates its command item in
place, with its exit code and output.

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: report `supportsBackgroundWait`, add `awaitBackgroundTasks` (matches a running root command by process id or item id), offer the late-exit continuation and stamp `completionWake: "always"` only for awaited commands, clear marks on exit and on `thread/closed`.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: cover the unawaited and awaited late exit; the existing wake tests mark their commands first.
- `apps/server/src/provider/CodexDeveloperInstructions.ts`: tell Codex to call `background_wait` for a background command it waits on.
