# 147 — Chat's Settled count and the way to project sessions

In Chat, the Settled shelf counted and paged older settled threads of every project, while it lists only chats, so it could show a count and "Show 25 more" with no rows. Chat now asks only for its scratch projects' older settled threads, and Code with no project chosen only for its non-scratch projects'; Code with a project chosen is unchanged. When project sessions exist, Chat ends its list with a quiet "Project sessions are in Code" link that selects the Code tab.

- `apps/web/src/components/Sidebar.tsx` — `useSidebarThreads` takes `settledProjectKeys` for the older-settled shelf: the project scope in Code, otherwise the projects of the current tab; adds the Chat link to Code.
- `apps/web/src/components/Sidebar.browser.test.tsx` — Chat with a settled chat and unloaded older project sessions counts one and offers no Show more, and Code with no project chosen leaves unloaded older chats out of its count and scopes; the link selects Code and shows only when project sessions exist.
- `apps/web/src/i18n/translations/*.json` — "Project sessions are in Code" added in every locale.

The scratch rule uses each environment's own `scratchWorkspaceRoot`, so remote environments follow it. The native mobile app has no Chat and Code tabs and is unchanged.
