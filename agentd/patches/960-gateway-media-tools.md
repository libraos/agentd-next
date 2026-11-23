# 960 — Media tools on a custom gateway

A chat in AgentD Next can make a video, speech or music, transcribe a recording, and list models through a custom gateway (Providers → Custom endpoint). Six tools on the app's own MCP server (`agentd-next`), so Claude Code, Codex and opencode threads all get them, locally and on remote hosts: `media_generate_video`, `media_video_status`, `media_generate_speech`, `media_transcribe`, `media_generate_audio`, `media_list_models`. Requests go from the app server, so the gateway key never reaches the agent and Codex's sandbox does not matter.

Ours (no upstream counterpart):

- `packages/contracts/src/gatewayMediaMcp.ts` — Tool inputs, results and `GatewayMediaFailure`.
- `apps/server/src/gateway/GatewayMediaClient.ts` (+ test) — Video in two dialects, chosen once per gateway by probing `{base}/videos/models`: OpenAI shape (`seconds`, `size`; resolution + aspect ratio become a size; audio not sent) or OpenRouter shape (`duration`, `resolution`, `aspect_ratio`, `generate_audio`, `usage.cost`). Speech, transcription, music/effects, model list; polling up to 55 minutes; downloads with `wx` so a file is never overwritten.
- `apps/server/src/gateway/GatewayMedia.ts` (+ test) — Picks the gateway (requested, else the one the thread runs on, else the only one, else a failure naming all) and keeps files inside the thread's workspace (`generated-media/` by default; a taken name gets `-1`, `-2`).
- `apps/server/src/gateway/CustomGateway.ts` — `connection(id)`: base URL and key, for the server only.
- `apps/server/src/gateway/gatewaySetup.ts` — `redactGatewayText`, shared by the existing refusal text and the media errors.
- `apps/server/src/mcp/toolkits/media/tools.ts`, `handlers.ts` — The toolkit; thread callers only, hidden from outside clients.

Upstream files:

- `apps/server/src/mcp/McpHttpServer.ts` — Register the media toolkit with its service.
- `apps/server/src/provider/AgentContextBudget.test.ts` — Mock `CustomGateway` for the tool list.
- `apps/server/src/provider/agentContextBudget.json` — Tool list grows by the six tools (needs the agent-context-increase label).
- `packages/contracts/src/index.ts` — Export the new contract.
- `packages/shared/src/t3McpToolPresentation.ts` — Labels for the six tools and a `media` summary action.
- `packages/client-runtime/src/t3ToolSummary.ts` — Summary line for the `media` action.
- `apps/web/src/i18n/translations/*.json`, `apps/mobile/src/i18n/translations/*.json` — The summary line in every locale.

Keys: read from the secret store on each call and sent only as the `Authorization` header to the gateway's own origin; a redirect (a signed storage link) is followed without it. Gateway errors reach the agent as their message, redacted of the key and of key-shaped text. Windows, Linux and macOS: Node path APIs only, no shell. Tested on Linux with a fake gateway only.

Not done: agentd background workers (no app MCP), the LibraOS gateway, a media UI, resuming a music job that outlives the 55-minute wait (only video has a status tool).
