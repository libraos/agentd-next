# 320: Customize: plugins, connectors and skills

The Plugins page becomes Customize, with three panes as in Claude (Customize) and Orca: Plugins, Connectors and Skills, chosen with `?pane=`. Connectors and Skills list each agent's own MCP servers and skills next to the details of the one chosen, and change them in the agent's own configuration: the app keeps no copy.

Upstream files changed:

- `packages/contracts/src/rpc.ts` — the six `agentd.customize*` methods.
- `packages/contracts/src/index.ts` — export the Customize contracts.
- `packages/contracts/src/clientRpcPermissions.ts` — the four Customize changes need maintain access.
- `apps/server/src/auth/RpcAuthorization.ts` — the connector list and the skill read need maintain access too: a command line can carry a token.
- `apps/server/src/observability/RpcInstrumentation.ts` — the Customize methods are agentd spans.
- `apps/server/src/ws.ts` — the Customize handlers call their services.
- `apps/server/src/server.ts` — provide the connector and skill services.
- `apps/server/src/ws.test.ts` — mock the two services.
- `apps/web/src/components/sidebar/SidebarChrome.tsx` — the sidebar entry is named Customize.
- `apps/web/src/components/CommandPalette.tsx` — Open plugins is also found by connectors, MCP and skills.
- `apps/web/src/i18n/translations/*.json` — the panes' strings in every locale.
