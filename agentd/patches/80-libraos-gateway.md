# 80 — LibraOS Gateway: connect a Console key; agentd and chats use it

Connecting a LibraOS API key (`lk_…`) in Welcome or Settings → Providers (Use an API key or gateway → LibraOS Gateway) checks it with `GET https://api.libraos.com/v1/models`, keeps it on the server, runs `agentd init --model-key FILE` with the bundled agentd, and adds three provider instances (Claude Code, Codex and opencode, each marked "· LibraOS Gateway") whose own environment and arguments reach the Gateway. Choosing one of them in the model picker is choosing the Gateway for that chat; the agent's own instance keeps its own login. Disconnect removes the key, agentd's key file and the three instances. "Custom endpoint" and the other options stay "Not available yet".

New files (ours): `packages/contracts/src/libraosGateway.ts`, `apps/server/src/gateway/` (`LibraosGateway.ts`, `gatewaySetup.ts` and their tests), `apps/web/src/lib/libraosGatewayState.ts`. `useLibraosGatewayConnected()` in the last one is what the Hand to a worker dialog (#78) reads to accept a `$` budget.

## Upstream files changed

- `packages/contracts/src/index.ts` — Export the Gateway contracts.
- `packages/contracts/src/rpc.ts` — Add the `libraosGateway.status`, `.connect` and `.disconnect` RPCs to the WebSocket group.
- `packages/contracts/src/clientRpcPermissions.ts` — Connect and disconnect need the environment-maintain scope, as agentd setup does.
- `apps/server/src/auth/RpcAuthorization.ts` — Reading the Gateway status needs the read scope.
- `apps/server/src/observability/RpcInstrumentation.ts` — Name the three RPCs' span group.
- `apps/server/src/server.ts` — Build the Gateway service beside agentd's, with the settings and secret store it writes.
- `apps/server/src/ws.ts` — Route the three RPCs to the Gateway service.
- `apps/server/src/ws.test.ts` — Mock the new service in the shared test layer.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — Enable the Gateway option and add its connect / connected / disconnect panel.
- `apps/web/src/components/onboarding/WelcomePage.tsx` — Pass the welcome environment to the chooser.
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` — Pass the Providers environment to the chooser.
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx` — The Gateway option is enabled now and opens the key field.

No provider adapter changed: upstream provider instances already carry per-instance environment variables (sensitive ones in the server's secret store), launch arguments and custom models, which is all a Gateway session needs:

- Claude Code: `ANTHROPIC_BASE_URL=https://api.libraos.com`, `ANTHROPIC_API_KEY` (sensitive); every model the key allows (its `anthropic/*` ones without the prefix) as custom models, which replace Claude's catalog (#117, #145).
- Codex: `-c model_provider="libraos"` with `model_providers.libraos` at `https://api.libraos.com/v1`, `wire_api="responses"`, `env_key="LIBRAOS_API_KEY"` (sensitive); every model the key allows (its `openai/*` ones without the prefix) as custom models, which replace Codex's catalog (#117, #145).
- opencode: `OPENCODE_CONFIG_CONTENT` with an `@ai-sdk/openai-compatible` provider at `https://api.libraos.com/v1`, the key read from `{env:LIBRAOS_API_KEY}`, every model the key lists, and only that provider enabled.

Nothing writes `~/.claude`, `~/.codex` or opencode's global config.

## Where the key is kept

`packages/secret-provider-core` has no writable OS keychain provider (its one driver, 1Password, only reads), and the server runs apart from Electron's `safeStorage`. The key therefore lives in the server's own secret store (`ServerSecretStore`, mode 600 files in a mode 700 `secrets` directory under the app's state directory: the store upstream uses for provider and source-control credentials), never in `settings.json` or logs. The settings service also keeps each Gateway instance's sensitive variable there. agentd gets its own copy in `<state>/agentd/libraos-gateway-key` (mode 600), which `config.toml`'s `[gateway] key_file` points at. Moving the key into a real OS keychain needs a writable secret provider first.

## agentd

`agentd init --model-key FILE` runs with no terminal, in the home folder (so it registers no repository), with `--no-services` when the bundled agentd has it. agentd writes `[gateway]`, `[dispatch]` and `[budget.prices]` from the Gateway's list into a config that has neither table, and leaves one that has them alone; the panel shows what agentd said when it did not take the key. An agentd without `--model-key` is named as too old. Disconnect removes agentd's key file but cannot remove `[gateway]` from `config.toml` (agentd has no command for that): its workers fail to read the key until the Gateway is connected again or the table is edited.

## Windows and Linux

Paths are built with `path.join`; agentd is found by the existing resolver (`.exe`/`.cmd`) and every process runs through `ProcessRunner`, never a shell. On Windows `chmod` does not restrict a file, so agentd's key file gets a user-only ACL with `icacls FILE /inheritance:r /grant:r USER:F`; a failure removes the file and the connect reports it. Checked on Linux only: typecheck, the gateway tests, the welcome browser test, and, with a revoked key, the real Codex CLI and Claude Code sending to `api.libraos.com/v1/responses` and `/v1/messages` with these arguments and variables (both got the Gateway's 401). opencode was not installed here, so its provider config is untested against a real opencode. Not verified on Windows: the `icacls` call, agentd accepting that file as "mode 600, yours" on Windows, and a Codex, Claude Code or opencode chat through the Gateway. No chat with a valid key was run on either system: no key was available here.
