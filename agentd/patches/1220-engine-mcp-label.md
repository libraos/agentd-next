# 1220 — LibraOS Engine's MCP server by its product name

LibraOS Engine registers its MCP server as `agentd`, so tool rows and the work-log summary read "Used agentd integration". `mcpToolPresentation` now names the servers `agentd`, `libraos-engine`, `libraos_engine` and `libraos-core` "LibraOS Engine", ahead of any display name the provider sends. Every adapter that presents MCP tools goes through it (Claude, Codex, ACP, Cursor, opencode, Pi).

A lone call row has no group summary, and the Engine has no icon to show where the call went, so the single-call label names an integration source when its call carries no icon: "LibraOS Engine: Handoff dispatch". A call with an icon keeps its plain title, as upstream.

Kept: the MCP server and `mcp__agentd__*` tool names (permission rules, skills and running sessions use them), the `mcp:agentd` source key, and the app's own `agentd-next` tools, which keep their own presentation. No icon: tool icons are image URLs and the app has no Engine logo to point at. Rows stored before this change keep the name they were stored with.

Upstream files:

- `packages/provider-core/src/server/mcpToolPresentation.ts` — Known-server name map for LibraOS Engine.
- `packages/provider-core/src/server/mcpToolPresentation.test.ts` — Engine server names, and third-party servers unchanged.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` — `mcp__agentd__handoff_dispatch` reaches the work log as LibraOS Engine, with and without display metadata.
- `apps/server/src/provider/CodexToolPresentation.test.ts` — New: a Codex `agentd` MCP call is LibraOS Engine; a third-party server keeps its name.
- `packages/client-runtime/src/work-log/presentation.ts` — `singleToolCallLabelWithSource`: name an icon-less integration on a lone call row.
- `packages/client-runtime/src/work-log/presentation.test.ts` — Its cases: no icon, icon on the call or source, name already in the label, non-integration sources.
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` — The single-call label goes through it.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` — A lone completed Engine call reads "LibraOS Engine: Handoff dispatch"; with an icon, "Handoff dispatch".
- `apps/mobile/src/lib/threadActivity.ts` — Same for the mobile single-call label.
- `apps/mobile/src/lib/threadActivity.test.ts` — Same cases on mobile.
