# 297: Refresh the Windows service launcher when the app places a new Engine

Since Engine v0.1.22 agentd's Windows tasks run `ROOT\services\agentd-service.exe`, a windowless launcher the agentd that registered them wrote from the copy it embeds. Engine v0.1.23 signs it, but the app's install pass only replaced `Programs\agentd\agentd.exe`: the tasks kept the older, unsigned launcher until something ran the new agentd's `install`, and Smart App Control blocks that launcher. The server's check also took a launcher task's program to be the launcher, a working program that isn't this app's agentd, so it counted the task as one the user kept.

New, ours:

- `packages/shared/src/agentdTasks.ts`: reading agentd's task definitions (moved from `apps/server/src/agentd/agentdServices.ts` so the desktop app reads them the same way), with `taskLauncher` (a task whose Command is its root's `services\agentd-service.exe`, and the agentd it runs as its first argument), `rootTaskDefinition` and `launcherEmbedded` (Windows releases embed the launcher byte for byte).
- `apps/desktop/src/backend/agentdInstall.ts`: on Windows, when the pass installs or replaces agentd.exe and every task of this root (AGENTD_ROOT, else agentd's default) runs this app's agentd (the placed copy or the bundled one, directly or through the launcher), that agentd's `install` runs once and its result goes into the install record as `services`. Nothing runs for an unchanged or kept agentd, on macOS or Linux, or when a task runs another agentd or can't be read.
- `apps/server/src/agentd/agentdServices.ts`: a launcher task's program is the agentd behind it; the install pass's copy counts as this app's; a launcher that this app's agentd doesn't carry is reported (`launcher`), with Repair running the install of the agentd those tasks run.
- `apps/server/src/agentd/AgentdBridge.ts`: passes the install pass's copy, and checks the services again on a status read once a new install pass is recorded, so a refresh that failed after the start check is shown.
- `apps/web/src/components/agentd/AgentdInstallStatus.tsx`: the notice for a launcher an older Engine wrote, and the Repair failure for it.
- `packages/contracts/src/agentd.ts`: `AgentdInstallRecord.services`, `AgentdServicesProblem.launcher`.
- Tests: `apps/desktop/src/backend/agentdInstall.test.ts` (upgrade and first install run install once; unchanged, kept-newer, kept-unknown, user's own agentd, macOS and Linux don't), `apps/server/src/agentd/agentdServices.test.ts`, `apps/server/src/agentd/AgentdBridge.test.ts`.

Upstream files changed:

- `packages/shared/package.json` — Exports `./agentdTasks`.
- `apps/web/src/i18n/translations/de.json` — The new web strings.
- `apps/web/src/i18n/translations/en.json` — The new web strings.
- `apps/web/src/i18n/translations/es.json` — The new web strings.
- `apps/web/src/i18n/translations/fr.json` — The new web strings.
- `apps/web/src/i18n/translations/ja.json` — The new web strings.
- `apps/web/src/i18n/translations/ko.json` — The new web strings.
- `apps/web/src/i18n/translations/pt-BR.json` — The new web strings.
- `apps/web/src/i18n/translations/ru.json` — The new web strings.
- `apps/web/src/i18n/translations/sv.json` — The new web strings.
- `apps/web/src/i18n/translations/zh.json` — The new web strings.
