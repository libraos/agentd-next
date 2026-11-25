# 225 — Chat tab matches the main pane

Follows `81-chat-code-tabs.md`. Chat means conversations with no project. The sidebar followed only server threads to their tab, because an unsent draft has no thread key. So a tab left on Chat stayed selected beside a project draft, for example the draft the landing page opens or one started with New thread. Now a draft follows its project's tab too: the draft id stands in for the thread key. Selecting Chat from a project draft starts a chat as before, and the tab follows that chat's draft. Selecting the tab the open thread or draft already belongs to keeps it in the main pane. Before, Code would leave an open project draft for the last remembered Code thread.

- `apps/web/src/components/Sidebar.tsx` — the route-follow key falls back to `draft:<id>` for an unsent draft; `selectSidebarTab` returns early when the open route already belongs to the chosen tab.
- `apps/web/src/components/Sidebar.browser.test.tsx` — the tab setup can open an unsent draft; tests check that a project draft moves Chat to Code, that a chat draft selects Chat, and that Chat from a project draft starts a chat while Code keeps the project draft.

Web/Electron UI only, the same on Windows, macOS and Linux; remote environments use the same rule. The native mobile app has no Chat / Code tabs and is unchanged.
