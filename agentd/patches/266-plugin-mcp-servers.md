# 266 — A plugin gives MCP servers to the agents the app launches

A plugin's `agentd-plugin.json` may declare `settings` (each `{ name, label, secret, description?, default? }`) and `contributes.mcpServers`, a map of server name to `{ command, args, env?, settings? }`. `command` resolves as a hook's does: a path with a slash is a file in the plugin's folder (made executable on install), anything else a program on PATH. `env` holds literal values; `settings` maps an env var to a setting, either by name (the value) or as `{ "setting": NAME, "file": true }` (the path of a file holding the value). A manifest with a field the app does not know is now refused, as are a server without a command, a command outside the plugin's folder, a server name with a dot (Codex splits config keys on dots), a setting a server names but the manifest does not declare, a secret setting with a default, and a secret setting given as a plain env value. `hooks` is now optional, so a plugin can carry only servers. `scripts/check-plugin-manifest.ts DIR` runs the same parser over a plugin folder for the catalogue's CI (exit 0 valid; 1 with one reason per line).

Settings are filled in Settings → Plugins. A value that is not secret goes in `<stateDir>/plugins/settings.json` under `values`; a secret one goes to the server's secret store (`ServerSecretStore`, name `agentd-plugin.<id>.<setting>`) and nothing else keeps it: the listing a client gets says only whether one is saved. A secret reaches a server only as a file: at each launch the app writes it to `<stateDir>/plugins/secret-files/<id>/<setting>` (folder 0700, file 0600, written via a temporary file created 0600) and puts that path in the env var, so the value is in no provider's argv, config, protocol log or query policy key. Removing the plugin deletes its secrets, its secret files and its values.

When a plugin is on for the thread's project (the environment setting with the per-project override, as for hooks) and its setup, if it declares one, has succeeded, each of its servers whose settings all have a value and whose command is found is attached to that launch. The MCP provider session carries a `pluginMcpServers` effect, read when a launch is made. Claude Code gets the servers in the query's `mcpServers`, which the adapter already sends with `setMcpServers` over the SDK's stdin, not in argv, `~/.claude.json` or `~/.claude/settings.json`. Codex gets `mcp_servers.<name>` thread config overrides on thread start, resume and fork, the same mechanism as `-c`, not `~/.codex/config.toml`. A server named like the app's own (`agentd-next`, `agentd-next-direct`) or like a server of a plugin earlier by id is left out. Other providers get none, and the plugin page says so. A launch never fails because of a plugin's server: one that cannot be attached is left out.

Ours (no upstream counterpart):

- `packages/contracts/src/agentdPlugins.ts`: the listing's `mcpServers` and `settings`, the settings input.
- `apps/server/src/agentd/pluginCatalog.ts` (+ test): the manifest's `settings` and `contributes.mcpServers`, strict parsing with reasons (`parsePluginManifest`), settings values, a server's env.
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): `setSettings`, `mcpServers(projectId)`, secret files, the listing's servers and settings, remove clears secrets; the test drives the plugin through both adapters' launch config, greps for a sentinel key and checks the run's home for agent config files.
- `apps/server/src/agentd/redactPlugin.test.ts`: `hooks` is optional.
- `apps/server/src/agentd/__fixtures__/mcp-plugin/agentd-plugin.json`: the outreach mailer's shape.
- `scripts/check-plugin-manifest.ts` (+ test).
- `packages/client-runtime/src/state/agentd.ts`, `apps/web/src/lib/agentdState.ts`: the settings command.
- `apps/web/src/components/agentd/AgentdPluginContributions.tsx` (+ browser test), `AgentdPagePlugins.tsx`: each server's command, args and env names, what it still needs, and the settings form with secrets masked and a Clear.

Upstream files:

- `packages/contracts/src/rpc.ts`: the `agentd.pluginsSetSettings` RPC.
- `packages/contracts/src/clientRpcPermissions.ts`: it needs environment maintain, as install does.
- `apps/server/src/observability/RpcInstrumentation.ts`: it counts as `agentd`.
- `apps/server/src/ws.ts`: its handler.
- `packages/provider-core/src/server/mcpSession.ts`: `pluginMcpServers` on the MCP provider session.
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts`: set it from the plugin service for the thread's project.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: add the servers to the query's MCP servers.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: add them as thread config overrides; export `codexThreadRuntimeParams` for the test.
- `knip.jsonc`: the check script is an entry.
- `apps/web/src/i18n/translations/*.json`: the new text in every locale.

Not done: the servers are listed only once a plugin is installed (install leaves it off, so before it is turned on, but not before install); the catalogue entry would have to carry them. A thread's servers are fixed when its provider thread starts or resumes (Codex) or its query opens (Claude), so turning a plugin on or off reaches a running thread at its next resume or query. With every app MCP capability turned off (no task, browser or device tools) the thread has no MCP session, and plugin servers are not attached either. Secret settings cannot yet point at an external secret provider reference (1Password); they are typed in. Mobile does not list plugins. A plugin's server runs as the user, like its hooks, so file modes do not keep one plugin's secret from another plugin's code; the catalogue's review is the boundary. Plugin tool calls ask for permission as any MCP tool does under the thread's permission mode. Tested on Linux only.
