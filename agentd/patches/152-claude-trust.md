# 152: Ask before a Claude worker runs in a folder Claude Code never trusted

Claude Code asks once per folder whether to trust it. A worker can't answer, so the first Claude worker in a new folder stopped at "Workspace not trusted". Now Start asks in the app instead: "Let Claude Code work in <folder>?" with Trust folder and Cancel. Cancel starts nothing. Trust records it for that folder only and then starts. A folder Claude Code already trusts (itself or a parent) asks nothing.

The check and the write run in the server, on the environment's host, so a remote environment trusts the folder on its own machine. The folder is the one Claude Code keys the project by: the main checkout from `git rev-parse --git-common-dir`, which covers the session's worktree and agentd's worker worktrees, else the working directory itself.

This is the one client config file the app changes (55 says no other is): the Claude Code config the environment's Claude reads, `CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. Only `projects[<folder>].hasTrustDialogAccepted = true` is written. The key uses forward slashes, as Claude Code's does on Windows. Every other key is kept, nothing of the file is logged or returned, and a file that isn't a JSON object is left alone with a message to accept the prompt in Claude Code once. The write goes to a temporary file beside the target and is renamed over it, with the file's mode kept (600 for a new file) and a symlinked config written where it points.

New, ours:

- `apps/server/src/agentd/claudeTrust.ts`: config path, project folder, trust lookup and the one-key write.
- `apps/server/src/agentd/claudeTrust.test.ts`: fixture configs on POSIX and Windows paths, `CLAUDE_CONFIG_DIR`, a missing file, a refused file, and the mode and symlink kept.
- `apps/web/src/components/agentd/ClaudeTrustDialog.tsx`: the question.

Shared files:

- `packages/contracts/src/agentd.ts`: `AgentdCommandError.untrustedFolder` and `AgentdStartTaskInput.trustClaudeFolder`.
- `apps/server/src/agentd/AgentdBridge.ts`: a local Start with the Claude worker checks trust before `agentd new`; it refuses with `untrustedFolder`, or writes the trust when `trustClaudeFolder` is set.
- `apps/server/src/agentd/AgentdBridge.test.ts`: the refusal, the consent and the second Start that asks nothing.
- `apps/web/src/components/agentd/taskPlan.tsx`: the `untrusted` outcome and Start with consent.
- `apps/web/src/components/agentd/StartTaskDialog.tsx`, `TaskDraftCard.tsx`: show the question; Trust starts again with consent.
- `apps/web/src/components/agentd/StartTaskDialog.browser.test.tsx`: the question, Cancel that starts nothing, and Trust.
- `apps/web/src/i18n/translations/*.json` (all 10): the question, its description and Trust folder.

Not covered: a team node's long-lived worker takes tasks for folders the app never sees, so it is not asked here. Cloud Workers run elsewhere and are not affected. Codex and opencode have no such per-folder prompt that blocks a worker.
