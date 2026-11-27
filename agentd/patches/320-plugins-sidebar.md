# 320: Plugins in the sidebar

Plugins get their own page (`/plugins`) and sidebar entry instead of a section of the LibraOS Engine page, as Claude (Customize → Plugins) and Codex (Plugins) do.

Upstream files changed:

- `apps/web/src/routeTree.gen.ts` — regenerate the route tree with `/plugins`.
- `apps/web/src/components/sidebar/mainAppLocation.ts` — open Plugins as a modal like Usage and LibraOS Engine.
- `apps/web/src/components/sidebar/SidebarChrome.tsx` — add Plugins to the sidebar footer.
- `apps/web/src/components/CommandPalette.tsx` — add the searchable Open plugins action.
- `apps/web/src/i18n/translations/*.json` — the page's strings in every locale.

New fork files: `apps/web/src/routes/_chat.plugins.tsx` and `apps/web/src/components/agentd/PluginsPage.tsx`. `AgentdPage.tsx` drops its Plugins section.
