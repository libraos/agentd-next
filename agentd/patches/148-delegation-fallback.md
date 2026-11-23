# 148: no orchestration tools, no orchestration instructions; worker requests go to the AgentD skill

With `enableAgentOrchestrationTools` off (the default, patch 6) a thread's `agentd-next` MCP server lists
only preview, device and HTML tools, but every adapter still sent the T3 orchestration sections, which say
to call `orchestrator_capabilities` before `delegate_task`. Asked to hand work to an AgentD worker, a chat
model followed that text, found neither tool and stopped. Sessions whose credential lacks `orchestration`
now get an "AgentD Next workers" section instead: those tools are not offered, use the AgentD skill or the
agentd MCP tools, say so if neither is there. The visuals section is kept.

## Upstream files changed

- `packages/provider-core/src/server/orchestrationInstructions.ts` — visuals section named; new
  `t3InstructionSections`/`t3Instructions(orchestration)` and the workers section; `t3OrchestrationSystemPrompt`
  takes an optional `hasOrchestrationTools` (default on, so other callers keep upstream text).
- `apps/server/src/provider/CodexDeveloperInstructions.ts` — `orchestration` in the availability; picks sections by it.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` — passes the session's `orchestration` capability.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` — `orchestrationToolsAvailable` option, same gate.
- `packages/provider-opencode/src/server/adapter.ts`, `.../v2/adapter.ts` — pass the capability to the system prompt.
- Tests: `CodexDeveloperInstructions.test.ts` (sections and per-entry cap without orchestration),
  `ClaudeAdapterV2.test.ts` (system prompt without task tools).

## Not changed

Cursor, ACP and Pi still send the orchestration text whenever the T3 server is present (upstream
providers, not agentd worker agents). A session with the setting on is unchanged.
