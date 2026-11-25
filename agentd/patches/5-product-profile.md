# 5: Product profile

The profile controls what AgentD Desktop and its web UI show, not what a connected environment supports or can execute. Usage, voice, browser, terminal, diffs, and files remain available; native mobile and server capabilities are unchanged.

Windows and Linux use the same UI flags and URL routes; no filesystem paths, shell commands, or native code changed. Browser checks ran on Linux, not on Windows.

- `apps/web/src/productProfile.ts` — defines one default-off switch per overlapping area.
- `apps/web/src/productProfile.test.ts` — exercises default-off redirects and verifies that each affected URL opens when its flag is on.
- `apps/web/src/state/environments.ts` — combines the existing sidebar availability checks with the profile, without touching shared sidebar code or changing server capabilities.
- `apps/web/src/components/CommandPalette.tsx` — filters optional navigation and related thread actions without replacing existing permission checks.
- `apps/web/src/components/CommandPalette.composition.browser.test.tsx` — checks that a capable environment does not expose hidden actions and Usage stays available.
- `apps/web/src/components/chat/DraftHeroHeadline.tsx` — uses the normal draft headline when triage is hidden.
- `apps/web/src/components/chat/QueuedRunsControl.tsx` — hides the automation settings link while retaining run content.
- `apps/web/src/components/chat/QueuedRunsControl.browser.test.tsx` — checks that queued automation content remains visible without the disabled settings link.
- `apps/web/src/components/chat/ThreadAutomationsPanel.tsx` — skips the automation controls and their queries when scheduled tasks are hidden.
- `apps/web/src/components/chat/ThreadAutomationsPanel.permissions.browser.test.tsx` — tests existing task permission checks with the feature switched on.
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx` — hides the automation settings link without changing message history.
- `apps/web/src/components/onboarding/WelcomePage.tsx` — gates the other mobile promotion and its link to Sharing & access.
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx` — checks that phone setup is hidden by default and still works when enabled.
- `apps/web/src/components/settings/ConnectionsSettings.tsx` — hides pull request routing settings while keeping environment connections.
- `apps/web/src/components/settings/LabsSettingsPanel.tsx` — hides guest sharing controls that link to Sharing & access, the Workflows switches (`workflows`) and Agent feedback (`agentFeedback`).
- `apps/web/src/components/settings/ScheduledTasksSettings.tsx` — keeps webhook delivery status but hides its settings link when Sharing & access is off.
- `apps/web/src/components/settings/SettingsPanels.tsx` — hides the mobile app promotion and pull request panel settings while retaining diff settings.
- `apps/web/src/components/settings/SourceControlSettings.tsx` — hides issue tracker connections without hiding Git and source control providers.
- `apps/web/src/components/settings/settingsSearch.ts` — keeps Settings navigation, search, and palette results in sync with the profile.
- `apps/web/src/components/settings/settingsSearch.test.ts` — checks default navigation and search without the hidden areas.
- `apps/web/src/lib/openPullRequestLink.ts` — leaves links that would require the standalone pull requests page to the normal link handler when the page is off.
- `apps/web/src/routes/_chat.issues.tsx` — redirects disabled Issues visits to chat.
- `apps/web/src/routes/_chat.pull-requests.tsx` — redirects disabled Pull requests visits to chat.
- `apps/web/src/routes/_chat.settings.access.tsx` — redirects disabled Sharing & access visits to chat.
- `apps/web/src/routes/_chat.settings.scheduled-tasks.tsx` — redirects disabled Scheduled tasks visits to chat.
- `apps/web/src/routes/_chat.workflows.tsx` — redirects disabled Workflows visits to chat.
- `apps/web/src/components/workflows/useWorkflowEnvironmentIds.ts` — no environment offers workflows while the profile hides them, so the command palette has no Open workflows.
- `apps/web/src/components/ChatView.tsx` — a workflow step thread does not link back to its run while workflows are hidden.
- `apps/mobile/src/features/agentd/productProfile.ts` (new) — the phone's switches for workflows and agent feedback.
- `apps/mobile/src/Stack.tsx` — the workflow run screen has no deep link while workflows are hidden (its tab is already off the tab bar upstream).
- `apps/mobile/src/features/settings/ThreadSettingsSections.tsx` — hides the Agent feedback section.
