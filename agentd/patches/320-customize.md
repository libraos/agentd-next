# 320: Customize: plugins, connectors and skills

The Plugins page becomes Customize, with three panes as in Claude (Customize) and Orca: Plugins, Connectors and Skills, chosen with `?pane=`. Connectors and Skills list each agent's own entries next to the details of the one chosen.

The Customize page shows the MCP servers ("connectors") and skills of the host's own agents, read from and written to each agent's own configuration. The app keeps no copy of them.

Connectors:

- **Claude Code.** Rows are read from Claude's files, never from `claude mcp list`, which starts every server. They come from four places: user and local servers in `CLAUDE_CONFIG_DIR/.claude.json` (else `~/.claude.json`), the project's `.mcp.json`, the servers of plugins Claude installed and turned on, and `managed-mcp.json`. The switch is Claude's own per-project `projects[<key>].disabledMcpServers`, the list `/mcp` disables with. The key is the main checkout, as for the trust prompt in 152. Adding and removing go through `claude mcp add-json <name> - --scope user|local` and `claude mcp remove`. The values go in on stdin and are cut out of anything passed back.
- **Codex.** Rows come from the app-server's `config/read` with layers, each scoped by the origin of its keys. The switch, add and remove go through `config/batchWrite` to the user's `config.toml`, with the version that was read, so a save Codex made meanwhile is refused as "changed". The person's own `CODEX_HOME` is used, also behind a shadow home.
- **Next plugin servers** show as `agentdPlugin` rows; they are changed on the Plugins pane. Other agents are listed as unsupported, with the reason.
- Rows carry env and header names, never values.

Writes to `.claude.json` (the switch here, and the trust of 152) go through a writer ported from Orca (MIT, pinned commit; listed in `third-party-licenses.config.json`). It publishes only while the file still holds the text the edit was made from, keeps the old text in a rolling `.bak` with the file's mode, and never replaces a save Claude made meanwhile. On a drive without hard links it refuses rather than risk that.

New, ours:

- `apps/server/src/agentd/agentConfigs/configFileWrite.ts`, `.test.ts`: the safe writer, and Orca's publish-race test ported.
- `apps/server/src/agentd/agentConfigs/claudeConnectors.ts`, `.test.ts`: Claude's rows, switch, add and remove.
- `apps/server/src/agentd/agentConfigs/codexConnectors.ts`, `.test.ts`: Codex's rows and batch writes.
- `apps/server/src/agentd/AgentdConnectors.ts`, `.test.ts`: instances from settings, project to folder, refusals (`locked`, `invalid`, `notFound`, `unsupported`, `changed`).
- `packages/contracts/src/agentdCustomize.ts`: the wire shapes.

Shared files:

- `packages/contracts/src/rpc.ts`: the `agentd.customizeConnector*` and skill RPCs.
- `packages/contracts/src/index.ts`: exports `agentdCustomize.ts`.
- `packages/contracts/src/clientRpcPermissions.ts`: the four Customize changes need the maintain scope.
- `apps/server/src/auth/RpcAuthorization.ts`: the connector list and the skill read need the maintain scope too: a listing names the host's files and commands, and a command line can carry a token.
- `apps/server/src/ws.ts`: handlers calling the two services.
- `apps/server/src/ws.test.ts`: mocks of the two services.
- `apps/server/src/observability/RpcInstrumentation.ts`: the RPCs are counted under `agentd`.
- `apps/server/src/server.ts`: the two layers, connectors given the plugins service and the project store.
- `apps/server/src/agentd/AgentdBridge.ts`: the trust write goes through the safe writer.
- `apps/server/src/agentd/claudeTrust.ts`, `.test.ts`: the safe writer; the `-custom-oauth` and legacy `.config.json` file names Claude uses.
- `apps/server/src/agentd/AgentdPlugins.ts`: `connectors(projectId)`, the plugin servers a project's agents get, read without network or secret files.
- `third-party-licenses.config.json`: the Orca notice.
- `apps/web/src/components/sidebar/SidebarChrome.tsx`: the sidebar entry is named Customize.
- `apps/web/src/components/CommandPalette.tsx`: Open plugins is also found by connectors, MCP and skills.
- `apps/web/src/i18n/translations/*.json`: the panes' strings in every locale.

Not covered: OpenCode, Pi and the other agents are listed as unsupported, because the app can't read or change their connectors yet. Claude switches per project only, as Claude itself does. Codex servers from a project, system or managed layer can't be switched or removed here, because writes go to the user's file only.
