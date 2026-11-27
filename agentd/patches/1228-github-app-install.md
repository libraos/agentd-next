# 1228 Install the LibraOS GitHub App from a cloud task

With "Run in the cloud" ticked and LibraOS's Job API configured, the Start dialog says the cloud
repository needs the LibraOS GitHub App and opens its install page (system browser on desktop). A
cloud task whose job ended with no repository access says the same in Background tasks. Another Job
API has its own App, so it keeps the generic text and no LibraOS link. Running the task again stays
the Start dialog's job: Background tasks has no rerun for finished cloud tasks.

New file: `apps/web/src/components/agentd/GitHubAppInstall.tsx`.

- `packages/contracts/src/agentd.ts` — `cloud.problem: "repository"` on a task.
- `apps/web/src/i18n/translations/*.json` — the new text in every language.
- `docs/user/workers.md` — a cloud task needs the GitHub App, and where to install it.
