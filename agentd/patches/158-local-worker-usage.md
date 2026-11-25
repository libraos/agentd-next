# 158 Local worker usage and where a task runs

Hand to a worker shows how many local workers run against agentd's limit, as "Local workers: 1 of 2 running". The limit is `agentd config get dispatch.max_workers`, read with the rest of status; the count is the task list's rows that run on this machine with a running worker. An agentd that names no limit (an older one, or 0) hides the line. The line is left out while the task goes to the cloud. Beside Run in the cloud, the form says where the task runs: on this computer or on a remote cloud machine, each using that machine's resources.

Shared files:

- `packages/contracts/src/agentd.ts`: optional nullable `AgentdStatus.maxWorkers`.
- `apps/server/src/agentd/agentdCommands.ts`: the `dispatch.max_workers` read.
- `apps/server/src/agentd/AgentdBridge.ts`: status reads it beside the default worker and model prices.
- `apps/server/src/agentd/AgentdBridge.test.ts`: status carries the limit, and null when agentd refuses the setting.
- `apps/server/src/agentd/taskDefaults.ts`: `readMaxWorkers`, a positive count or null.
- `apps/server/src/agentd/taskDefaults.test.ts`: `readMaxWorkers` cases.
- `apps/web/src/components/agentd/taskPlan.tsx`: the plan carries `maxWorkers`.
- `apps/web/src/components/agentd/StartTaskDialog.tsx`: the usage line.
- `apps/web/src/components/agentd/StartTaskCloud.tsx`: the location copy beside Run in the cloud.
- `apps/web/src/components/agentd/StartTaskDialog.browser.test.tsx`: the usage line, its absence without a limit or with the cloud chosen, and the copy for each choice.
- `apps/web/src/i18n/translations/de.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/en.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/es.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/fr.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/ja.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/ko.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/pt-BR.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/ru.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/sv.json` adds the usage line and the two location lines.
- `apps/web/src/i18n/translations/zh.json` adds the usage line and the two location lines.
