# #78: Hand-off fixes from the Windows newcomer test

## 8. Findable

- `apps/web/src/components/chat/ThreadDetailsAgentdWorkers.tsx` (ours): a lasting "Hand to a worker" row in the session panel's workers section opens the Hand to a worker dialog, shown only when the environment allows starting a task.
- `packages/client-runtime/src/providerSkills.ts` (upstream): the `/` menu hides the bundled `agentd` and `agentd-setup` skills, and provider commands of the same names, so the dialog is their one entry. Web and mobile both read this helper.
- `packages/client-runtime/src/providerSkills.test.ts` (upstream): a row for the hidden names, with another skill still shown.

The button reuses the existing "Hand to a worker" string, so no new translation key. The change is web UI and a pure filter with no paths or processes, so it is the same on Windows and Linux; it was not run on Windows.
