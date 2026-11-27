# 1220 — LibraOS Engine's MCP server by its product name

LibraOS Engine registers its MCP server as `agentd`, so tool rows and the work-log summary read "Used agentd integration". `mcpToolPresentation` now names the servers `agentd`, `libraos-engine`, `libraos_engine` and `libraos-core` "LibraOS Engine", ahead of any display name the provider sends. Every adapter that presents MCP tools goes through it (Claude, Codex, ACP, Cursor, opencode, Pi).

Kept: the MCP server and `mcp__agentd__*` tool names (permission rules, skills and running sessions use them), the `mcp:agentd` source key, and the app's own `agentd-next` tools, which keep their own presentation. No icon: tool icons are image URLs and the app has no Engine logo to point at. Rows stored before this change keep the name they were stored with.

Upstream files:

- `packages/provider-core/src/server/mcpToolPresentation.ts` — Known-server name map for LibraOS Engine.
- `packages/provider-core/src/server/mcpToolPresentation.test.ts` — Engine server names, and third-party servers unchanged.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` — `mcp__agentd__handoff_dispatch` reaches the work log as LibraOS Engine, with and without display metadata.
- `apps/server/src/provider/CodexToolPresentation.test.ts` — New: a Codex `agentd` MCP call is LibraOS Engine; a third-party server keeps its name.
