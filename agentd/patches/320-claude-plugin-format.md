# 320: Plugins in Claude Code's format

A plugin is a Claude Code plugin folder (`.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `commands/`, `agents/`, `hooks/`) and a catalogue is a `.claude-plugin/marketplace.json` whose entries are pinned by a `git-subdir` source with a `sha` and a `version`. The earlier `agentd-plugin.json` and `catalog.json` are still read; both become one definition (`claudePluginFormat.ts`). What Claude has no word for (the before-send hook, setup, a secret kept as a file) stays in `agentd-plugin.json` with `schemaVersion: 2`, which Claude never reads.

Who gets what:

- Claude loads the folder itself (`plugins` on the query), so its skills, commands, agents, hooks and remote MCP servers work as in Claude Code. Setting values go in `pluginConfigs["<name>@inline"].options` of the query's flag settings, merged with the user's own `--settings`.
- The app still starts a plugin's stdio servers itself for every provider: that keeps the setup and settings gates, secret files, the Windows Python lookup and the same tool names on Claude and Codex. So that Claude does not start them a second time, each is named in `deniedMcpServers` as `plugin:<plugin>:<server>` (checked with Claude Code 2.1.332).
- Codex gets stdio servers and streamable HTTP servers (`url`, `http_headers`) as thread config overrides. An SSE server, or one that signs in with its own OAuth client, reaches Claude only, and the listing says so. Codex gets no plugin skills, commands, agents or hooks.
- A `sensitive` userConfig option named in `.mcp.json` is refused: the app cannot fill Claude's keychain. A secret is a `secretFiles` option instead, whose value is the path of a 0600 file.

A marketplace entry may carry `libraos.renamedFrom`, the id the plugin had before. An installed plugin with that id stays listed under it with the new version; updating it installs the new id, moves its switches, values, secrets with the same name and data folder, and removes the old install. Setup runs again, as after any update.

Upstream files changed:

- `packages/provider-core/src/server/mcpSession.ts` — `claudePlugins` on the MCP provider session; a plugin server may be an HTTP one.
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts` — set `claudePlugins` from the plugin service for the thread's project.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` — pass the folders, their option values and the deny list; a changed list starts a new query.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` — an HTTP plugin server becomes `url` and `http_headers`.

Not done: OpenCode and the other providers get nothing from a plugin. A plugin with the same name as one the user installed in Claude Code itself is loaded twice. Two enabled plugins with the same name: the first by id is the one Claude loads.
