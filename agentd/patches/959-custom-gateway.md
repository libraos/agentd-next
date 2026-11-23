# 959 — Custom gateway as a provider (#165)

Settings → Providers → Use an API key or gateway → **Custom endpoint** adds a gateway by URL (company proxy, LiteLLM, OpenRouter, self-hosted). An OpenAI-format gateway becomes Codex and opencode provider instances, an Anthropic-format one Claude Code and opencode instances, named `<agent> · <name>` (the URL when no name is given). Its models come from `<url>/v1/models`, or from ids the user types when that list cannot be read.

Ours (no upstream counterpart):

- `packages/contracts/src/customGateway.ts` — Gateway setting, summary, RPC inputs and results, `isGatewayInstanceId`.
- `apps/server/src/gateway/CustomGateway.ts` (+ test) — list/add/rename/remove/refreshModels; key in the secret store under `custom-gateway-key-<id>`.
- `apps/server/src/gateway/gatewaySetup.ts` (+ test) — LibraOS Gateway's instance builder generalised to a per-gateway shape; LibraOS output unchanged.
- `apps/server/src/gateway/gatewayKeyModels.ts` — `askModels` takes base URL, name and optional key; LibraOS calls it as before.
- `apps/web/src/lib/customGatewayState.ts`, `apps/web/src/components/onboarding/CustomGatewayForm.tsx`, `CustomGatewayList.tsx` — Form and "Your gateways" list.
- `apps/web/src/lib/libraosGatewayState.ts` — Export `useGatewayEnvironment` so both gateways resolve the same environment.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — Enable Custom endpoint; open the form and show the list.
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx` — Custom endpoint is now enabled and opens the form.

Upstream files:

- `packages/contracts/src/settings.ts` — `customGateways` server setting (default `[]`); patch field kept out of `ClientServerSettingsPatch` and counted as a provider change.
- `packages/contracts/src/rpc.ts` — Five `customGateway.*` WS methods.
- `packages/contracts/src/clientRpcPermissions.ts` — Add/rename/remove/refresh need `environment:maintain`, as the LibraOS Gateway connect does.
- `packages/contracts/src/index.ts` — Export the new contract.
- `apps/server/src/auth/RpcAuthorization.ts` — `customGateway.list` needs `orchestration:read`, as `libraosGateway.status` does.
- `apps/server/src/observability/RpcInstrumentation.ts` — Span group for the new methods.
- `apps/server/src/ws.ts` — Handlers; a provider Refresh on a `gw-<id>-*` instance also refreshes that gateway's models.
- `apps/server/src/ws.test.ts` — Mock the new service in the RPC layer.
- `apps/server/src/server.ts` — Provide the CustomGateway layer.
- `apps/server/src/provider/ProviderRegistry.ts`, `apps/server/src/provider/providerStatusCache.ts` — Treat custom gateway instances like LibraOS Gateway ones: a model missing from the gateway's list is gone, not kept from cache.
- `apps/web/src/i18n/translations/*.json` — New strings in every locale.

Keys: kept in the server secret store and in instance variables marked `sensitive`; clients see only `hasKey`. Error text from the gateway is redacted of the key itself and of `sk-`/`lk-`/Bearer shapes. No key means no key variable, no Codex `env_key` and no opencode `apiKey`. An Anthropic-format gateway needs a key: without one, Claude Code would send the person's own Claude login to it.

The user's own provider instances and the agents' config files are not touched: each gateway only adds, renames or removes its own `gw-<id>-claude|codex|opencode` instances. Windows, Linux and macOS: only environment variables and launch arguments (`-c` for Codex, `OPENCODE_CONFIG_CONTENT`, `ANTHROPIC_BASE_URL`), as LibraOS Gateway already uses on all three; no new paths or processes. Tested on Linux only.

Not done: agentd workers using a custom gateway, adding one from mobile (its instances still show in the mobile picker), and the other disabled choices (Anthropic/OpenAI API key, Bedrock, Ollama).
