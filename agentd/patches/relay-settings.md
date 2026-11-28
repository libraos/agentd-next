# Relay settings: see and revoke relay devices in Settings

**Settings → Relay** shows what `lnext relay status|devices` print: the relay this computer uses,
its host id, whether the server's control socket is open, and each relay device with when it was
paired and last connected. **Revoke** runs the same `revokeRelayDevice` as `lnext relay revoke`:
the key goes here first, then the relay drops the device's token. Reading needs `access:read` and
revoking `access:write`, the grants the authorized clients list already uses; the server checks both.

The relay host writes `relay/host-status.json` (open or not, with its pid) and
`relay/last-connected.json`, so the CLI and the page read connection state without the server's memory.

A session made with a relay pairing code (the link's one-time token) is linked to the key that code
paired, by the code's hash, in `relay/sessions/`. Revoking that session in Settings revokes the key;
"revoke other clients" revokes every key another session paired, and keeps the caller's own and keys
paired before this change. Revoking a pairing link drops its unused relay code.

Our code: `apps/server/src/agentd/relay/{relayDevices,relayAuthHooks,relayHostRpc}.ts`,
`packages/contracts/src/relayHost.ts`, `apps/web/src/lib/relayHostState.ts`,
`apps/web/src/components/agentd/RelaySettings.tsx`.

## Upstream files changed

- `apps/server/src/auth/http.ts`: links a session to its relay key after a pairing-code exchange; revoking a session, other sessions or a pairing link revokes the relay key or code too.
- `apps/server/src/ws.ts`: the `relayHost.status` and `relayHost.revokeDevice` handlers.
- `apps/server/src/auth/RpcAuthorization.ts`: `relayHost.status` needs `access:read`.
- `apps/server/src/observability/RpcInstrumentation.ts`: the two relay methods' aggregate.
- `apps/server/src/cli/pair.ts`: the relay pairing code records its pairing link.
- `packages/contracts/src/rpc.ts`: the two relay RPCs.
- `packages/contracts/src/index.ts`: exports the relay host schemas.
- `packages/contracts/src/clientRpcPermissions.ts`: `relayHost.revokeDevice` needs `access:write`.
- `apps/web/src/routes/_chat.settings.relay.tsx`: new route for the page.
- `apps/web/src/routeTree.gen.ts`: regenerated for that route.
- `apps/web/src/components/settings/settingsSearch.ts`: the Relay page in the Connections group and in search.
- `apps/web/src/components/settings/SettingsSidebarNav.tsx`: its icon.
- `apps/web/src/i18n/translations/*.json`: the page's copy.
- `docs/user/remote-access.md`: Settings → Relay, and revoking a sign-in revokes its relay key.
