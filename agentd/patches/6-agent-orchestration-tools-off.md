# 6: agent sessions get no base-app orchestration tools by default

Setting: `enableAgentOrchestrationTools` in server `settings.json`, default `false`. Off: a
session's `t3-code` credential holds only `preview` (when browser access allows it) and
`device` (when device access allows it); with neither, no `t3-code` server is injected. On:
upstream behaviour (orchestration, worktree, pull-requests, issues, plus preview/device).

## Upstream files changed

- `packages/contracts/src/settings.ts` — one `ServerSettings` field, default off. Not added to
  `ServerSettingsPatch` (outside this task's lines), so it is set in `settings.json` for now.
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts` — reads the setting in
  `prepareMcpSession`, builds the capability set (`agentMcpCapabilities`), skips injection
  (revokes and clears the thread's MCP session) when the set is empty, and reissues a cached
  credential when the setting flips.
- `apps/server/src/mcp/McpSessionRegistry.ts` (not owned, 4 lines) — `issue` always added the
  four task capabilities; new `taskTools: false` request flag leaves them out. Default unchanged.
- `apps/server/src/mcp/McpHttpServer.ts` (not owned, ~20 lines) — tool calls were already
  refused without the capability, but `tools/list` still advertised every tool. A thread
  credential without `orchestration` now lists only the preview, device and HTML tools (and
  `tool_search` for deferring clients). Client (OAuth) credentials are unaffected.
- Tests: `ProviderSessionManager.test.ts` (off/on capability sets, browser-only, device-only,
  none → no injection; existing browser/device tests pinned to the setting on),
  `McpHttpServer.test.ts` (a preview-only thread credential lists none of the PR tools).

## Adapters start without the injection; the agent's own MCP servers still load

Confirmed by reading the code (no adapter change needed):

- Claude (`ClaudeAdapterV2.ts`, `claudeMcpQueryOverrides`): with no MCP session it returns no
  `mcpServers` override, so the SDK keeps the servers from `settingSources`
  (`user`, `project`, `local`; `project`, `local` with a custom home).
- Codex (`CodexAdapterV2.ts`, `codexThreadRuntimeParams`): the per-thread config adds only the
  `mcp_servers.t3-code*` keys when a session exists; without it nothing is overridden, so
  `~/.codex/config.toml` and launch-argument servers load as before.
- opencode (`provider-opencode/src/server/adapter.ts`): `client.mcp.add("t3-code")` runs only
  when an MCP session exists; the user's `opencode.json` servers are loaded by opencode itself.

## Windows

Nothing platform-specific: the change is a settings field, a capability set and an MCP
`tools/list` filter. No paths, binaries, processes or shell commands are involved. Not run on
Windows; the tests are platform-neutral.

## Open

- With browser access on (the default) the session still gets `t3-code` with preview tools,
  and the adapters' T3 orchestration instructions (`provider-core` `orchestrationInstructions`)
  were still sent whenever any `t3-code` server is present. Codex, Claude and opencode gate them on
  `orchestration` since #148 (`148-delegation-fallback.md`); Cursor, ACP and Pi do not.
- No UI toggle (needs `ServerSettingsPatch` and a settings row).
