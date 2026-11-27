# 320: Customize → Skills switches the agent's own setting

The Skills pane shows a listed skill's SKILL.md and turns it on or off where the agent itself keeps that switch, so the agent and its own CLI agree. The app keeps no list of its own. Only a path the instance's current skill list names (the machine's, or the project's folder) can be read or switched.

- Claude Code: `skillOverrides[name]` = `"off"` in its settings, removed again to turn on (or `"on"` when a lower file turns it off). It goes in the file that decides today: the user's `<configDir>/settings.json`, or a project's `.claude/settings.local.json` when a project file sets it. A skill managed settings decide stays locked, and so does a file whose map Claude would drop (Claude ignores the whole map if one value is invalid). Comments and layout are kept.
- Codex: its app-server's `skills/config/write`, run as a short-lived app-server with the instance's own home and launch. Codex reports the switch in effect; when another Codex setting overrides it, the pane says so. Checked with Codex 0.169 and a temporary `CODEX_HOME`.
- A plugin's skill follows its plugin. OpenCode, Pi and the others have no per-skill switch the app can write, so their skills are read-only.

Upstream files changed:

- `packages/provider-core/src/server/driver.ts` — optional `skillSwitch` on `ProviderInstance`, so a driver says where its skill switch lives.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` — give the instance's config dir and environment as its `skillSwitch`.
- `apps/server/src/provider/Drivers/CodexDriver.ts` — give `codexSkillSwitch` with the instance's binary, home and launch args.
- `apps/server/src/provider/Drivers/CodexManagedProvider.ts` — the same for the managed Codex runtime.
- `apps/server/src/provider/Drivers/ClaudeSkills.ts` — export the settings-file order, managed paths, repository root lookup and `SkillOverrideValue`, so the writer matches the reader.
- `apps/server/src/server.ts` — build the skills service beside the provider registry it reads and refreshes.
- `apps/server/package.json`, `pnpm-lock.yaml` — `jsonc-parser`, to edit settings files without losing comments.

New fork files: `apps/server/src/agentd/codexSkillSwitch.ts` and the service's tests.
