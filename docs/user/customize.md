# Customize

**Customize** in the sidebar has three panes: **Plugins** (see [Plugin catalogues](plugin-catalogues.md)), **Connectors** and **Skills**. Connectors and Skills show your agents' own MCP servers and skills and change them in each agent's own configuration, so the agent's CLI sees the same thing. LibraOS Next keeps no copy.

Both panes need maintain access to the environment.

## Connectors

The list shows each agent's MCP servers, with the names of their environment variables and headers but never the values. Choose a project to include that project's own servers.

- **Claude Code** turns a connector off per project, as its `/mcp` does, so choose a project first. **Add connector** writes to all projects, or to this project for you only. A server from the project's `.mcp.json` or a Claude plugin can be switched but not removed here, and one from managed settings is locked.
- **Codex** turns a connector off for every project. Only servers in your own `config.toml` can be changed.
- A connector that comes with a LibraOS Next plugin is turned on or off with its plugin, under Plugins.
- OpenCode and the other agents are listed as not supported here.

If the agent saved its configuration while you were editing, the change is refused; try again.

## Skills

The list shows the skills each agent reports, with the chosen project's own. Open one to read its `SKILL.md` and turn it on or off.

- **Claude Code** keeps the switch in its settings (`skillOverrides`): your user settings, or the project's `.claude/settings.local.json` when the project already decides it. A skill set by managed settings is locked.
- **Codex** keeps the switch for every project in its own configuration.
- A plugin's skill follows its plugin. Other agents' skills can be read but not switched.
