# #240 — Plugin MCP sign-in notices wait for a tool call

- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` — Hold the sign-in notice of a needs-auth server a Claude plugin ships (`source: "plugin"`) until a turn calls one of its `mcp__<server>__*` tools, then show it once per session; other servers are unchanged.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` — Cover a plugin server staying quiet on turns that do not call it, raising the notice on its first tool call, and not repeating it.

Only Claude Code reports MCP sign-in status this way; Codex, opencode and Pi have no plugin MCP servers with this status, so no change there. The notice and its text are the existing ones, so no locale change.
