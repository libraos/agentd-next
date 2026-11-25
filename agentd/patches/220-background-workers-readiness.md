# 220: Background workers readiness

One "Background workers" state, Ready / Setup required / Setup failed, in the sidebar indicator, and the same check in Hand to a worker before anything starts.

- **Ready** means: LibraOS Engine is installed, set up (agreement accepted) and no doctor check fails; the worker is signed in (agentd's `claude-login`, `codex-login` or `opencode-worker` check passes for it); and the open project is a Git repository. With no project open, only the first two are judged. Login checks are left out of the failing-check scan, since only the worker that would run matters (agentd fails `claude-login` and `codex-login` together when neither is signed in). An agentd without the worker's login check is taken as signed in: agentd refuses the worker itself.
- **Setup required** names the engine (not installed, not set up), the worker's sign-in (with agentd's detail and fix, such as `claude auth login`) or the repository (`git init`). **Setup failed** names the failing doctor check with agentd's fix, or says LibraOS Engine did not answer.
- **Skills.** The status read now carries `missingSkills`: the `agentd` and `agentd-setup` Skills the default worker cannot find in its Skills folders (opencode also reads Claude Code's and Codex's). Ready then shows a warning with `libraos-core connect <worker>`; nothing is blocked.
- **Indicator.** The sidebar row reads "Background workers: …" for the open thread's (or draft's) environment and project, else the primary environment. Every state opens the popover: the reason, the fix, Set up LibraOS Engine where the connection can, then the existing This machine / LibraOS account lines and the LibraOS Engine page and Worker settings links. The tooltip carries the reason.
- **Hand to a worker.** `useTaskPlan`, shared by the dialog and the chat's task card, judges readiness for the chosen worker (no sign-in for Cloud Workers). A missing prerequisite disables Start, shows the reason and fix in place of the problem line, and `run` refuses with it. With no worker named, the form's own "Choose a worker" still says so.

Files (all ours unless marked):

- `packages/contracts/src/agentd.ts`: `AgentdStatus.missingSkills` (optional; shared file, one field).
- `apps/server/src/agentd/skillCatalog.ts`: `AGENTD_SKILLS`, `workerSkillsDirectories`.
- `apps/server/src/agentd/skillCatalog.test.ts`: the opencode folders.
- `apps/server/src/agentd/AgentdBridge.ts`: `status` adds `missingSkills` for the default worker.
- `apps/server/src/agentd/AgentdBridge.test.ts`: the status test has one of the two Skills in a scratch home.
- `apps/web/src/components/agentd/agentdVisibility.logic.ts`: `workerReadiness`.
- `apps/web/src/components/agentd/agentdVisibility.logic.test.ts`: each prerequisite, the chosen worker, Cloud Workers, Skills.
- `apps/web/src/components/agentd/WorkerReadiness.tsx` (new): `useAgentdState` (moved from the indicator), the readiness text and notice.
- `apps/web/src/components/agentd/AgentdIndicator.tsx`: the row shows readiness and always opens the popover.
- `apps/web/src/components/agentd/taskPlan.tsx`: the readiness check before Start.
- `apps/web/src/components/agentd/WorkersSettings.tsx`, `AgentdThreadNudges.tsx`: import `useAgentdState` from its new file.
- `apps/web/src/i18n/translations/*.json`: new strings in every locale; the four "LibraOS Engine: …" indicator labels are gone.
- `docs/user/workers.md`: the Background workers line.

Not verified:

- In a running app: the logic and the dialog are covered by tests, the indicator and popover were not opened in a browser.
- Windows and macOS: built and tested on Linux only. The Skills folders follow the same paths as the Skills catalogue and the desktop install.
