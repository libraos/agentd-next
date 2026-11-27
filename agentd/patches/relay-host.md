# Relay host: reach this computer through an end-to-end encrypted relay

A computer connects to a relay with `libraos-next relay connect <url> --token <token>` and keeps
one outgoing control socket open. For each phone the relay announces, the server opens a session
socket and runs Noise XK (`Noise_XK_25519_ChaChaPoly_BLAKE2s`) with the phone; a stream
multiplexer inside it carries HTTP requests and WebSockets to the server on loopback. Only a phone
whose key is paired here, or that brings a one-time pairing code from this computer's link, gets
past the handshake. `libraos-next pair` adds the relay, host id, host key and a device token to
the link's fragment. Our code is `packages/relay-session` and `apps/server/src/agentd/relay`.

The relay sends `{"type":"hello","hostId":"…"}` when the control socket opens; `relay connect`
takes `--host-id` for a relay that does not. A WebSocket message larger than one Noise message is
split over frames whose type byte has its top bit set while the message continues.

## Upstream files changed

- `apps/server/src/server.ts`: the relay host layer runs beside the other server application layers.
- `apps/server/src/binCli.ts`: registers the `relay` command.
- `apps/server/src/cli/pair.ts`: the pairing link carries the relay when this computer is connected
  to one; the loopback-only note is left out then.
- `apps/server/package.json`: the session package, and `ws` for the in-process test relay.
- `pnpm-workspace.yaml`: `@noble/ciphers` in the catalog.
- `docs/user/remote-access.md`: relay setup, pairing and revoking.
