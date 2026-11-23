# 55: Install agentd and its Skills for the terminal and the agents, after consent

After the person continues past first run (`onboardingCompletedAt` is set), the desktop app puts its bundled agentd where `install.sh` / `install.ps1` would and the two agentd Skills into each installed client. Nothing is written before that, and nothing on a build without a bundle (dev).

New, ours:

- `apps/desktop/src/backend/agentdInstall.ts`: the install pass. Binary to `<HOME>/.local/bin/agentd` (Linux) or `%LOCALAPPDATA%\Programs\agentd\agentd.exe` (Windows), home and LOCALAPPDATA from the environment. Same bytes: nothing. A readable older version: replaced atomically (copy to `agentd.new.<pid>`, rename over; Windows renames the old exe to `.old` first and puts it back if the rename fails). A newer one, or one whose version cannot be read: left alone. Skills (`SKILL.md` as `agentd-setup`, `SKILL-agentd.md` as `agentd`) into `CLAUDE_CONFIG_DIR|~/.claude/skills` (Claude Code), `~/.agents/skills` (Codex) and `XDG_CONFIG_HOME|~/.config/opencode/skills` (opencode, only when neither of the others already has them), each client only when its command is on PATH or its home exists, as `install.sh` does. A differing Skill is kept beside the new one as `.agentd-backup-…`; symlinks are never written through; without a new binary only missing Skills are added. No client config file is changed (the one exception, outside this pass, is Claude Code's per-folder trust key after the person agrees; see 152). Each pass writes `<stateDir>/agentd-install.json`.
- `apps/desktop/src/backend/agentdInstall.test.ts`: the replace/keep decision and the Windows PATH entry, hand-written values.
- `apps/desktop/resources/agentd-uninstall.nsh`: `customUnInstall`; on a real uninstall (not an update) and only while the app's marker `agentd-desktop-installed` is beside the binary, removes the folder's user PATH entry (other entries and the value's type kept), `agentd.exe`, its `.old`, the marker and the then-empty folder. `AGENTD_ROOT` is never touched.
- `apps/web/src/components/agentd/AgentdInstallStatus.tsx`: the AgentD page's Status shows the agentd binary the app runs and the install location; when that folder is not on PATH (Linux/macOS) it shows the line to add once, dismissed per folder (local storage).

Upstream files changed:

- `scripts/build-desktop-artifact.ts`: `stageAgentdCli` also checks `SKILL.md` and `SKILL-agentd.md` against `SHA256SUMS` and copies them into `resources/agentd/` beside the binary (`AGENTD_SKILL_ASSETS`); a missing or mismatched Skill fails the build like the binary.
- `scripts/build-desktop-artifact.test.ts`: the staging test now has the Skills, and a mismatched Skill fails.
- `apps/desktop/resources/installer.nsh`: one `!include` of `agentd-uninstall.nsh`.
- `apps/desktop/src/app/DesktopApp.ts`: at start-up, after the login-shell PATH is known, run the install pass when consent was already given (forked; a failure only logs).
- `apps/desktop/src/ipc/methods/clientSettings.ts`: when a settings write turns `onboardingCompletedAt` from unset to set, run the install pass (forked). This is the consent moment.
- `apps/desktop/src/app/DesktopCliCommand.ts`: export `WINDOWS_USER_PATH_SCRIPT`, so the user PATH is written through the same script and process wrapper as the `t3` command's (REG_EXPAND_SZ kept, Explorer notified).

Shared files (entries added at the end, fewest lines):

- `apps/desktop/src/backend/agentdBinary.ts`: export four existing helpers (binary name, version compare, bundled path, version read).
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts`: the primary backend gets `AGENTD_DESKTOP_INSTALL_RECORD` (path of the record).
- `packages/contracts/src/agentd.ts`: `AgentdInstallRecord`; `AgentdStatus` gains optional `binary` and `install`.
- `apps/server/src/agentd/AgentdBridge.ts`: `status` adds the resolved binary and the decoded record (unset, missing or unreadable: null).
- `apps/server/src/agentd/AgentdBridge.test.ts`: the status test reads a hand-written record.
- `apps/web/src/components/agentd/AgentdPageReads.tsx`: renders `AgentdInstallStatus` in the Status section.

Not changed: `agentdCommands.ts`, the RPC wiring and `agentdState.ts` (the status RPC already carries the new fields). The deb/rpm postinst is not changed: the first launch after consent installs agentd, which is what consent requires.

Windows: paths built with `path.join` from `USERPROFILE`/`LOCALAPPDATA`; the PATH write spawns `powershell.exe` from `SystemRoot` through `ChildProcessSpawner` (no shell), and a failed read leaves PATH alone. Not verified on Windows: the install pass itself, the rename-aside of a running `agentd.exe`, the PATH write, and the NSIS uninstaller (`customUnInstall`, `${isUpdated}`); the NSIS file was not compiled here. Linux: the pass was run end to end against a scratch home (install, newer kept, older replaced, edited Skill backed up, record written).
