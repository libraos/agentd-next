# Relay phone: the mobile app reaches its computer through the relay

A pairing link with a relay route (see `relay-host.md`) makes the phone a device key, saves it with
the link's route and one-time code in the keychain, and pairs. When the link's address does not
answer, the sign-in exchange itself goes through the relay. Either way the entry gets a second
route to `https://<host id>.relay.invalid/`, which borrows the paired credential and ranks last, so
the existing route logic prefers the direct address and moves back to it when it answers.

Only the phone's transport knows that address: its fetch and WebSocket constructor send it through
one Noise tunnel per host (`packages/relay-session/src/device.ts`, `deviceRouter.ts`) and pass every
other URL on. The relay host presents that address to the server as a local TLS proxy would, so DPoP
proofs verify through the relay. A relay or host that refuses the phone answers as a refused
sign-in, and the environment row asks to pair again. Web and desktop do not provide the relay
capability, so they ignore the route and pair directly as before. Our code is
`apps/mobile/src/features/agentd/relay` and the relay-session files above.

## Upstream files changed

- `packages/client-runtime/src/connection/onboarding.ts`: pairs through the relay when the link's
  address does not answer, and adds the relay route after registering.
- `packages/client-runtime/src/connection/registry.ts`: `addRoute`, one route added to a saved
  environment.
- `packages/client-runtime/src/connection/routes.ts`: a relay address is a relay route; its id
  names the credential it borrows, and it goes with that route.
- `packages/client-runtime/src/platform/capabilities.ts`: the optional `RelayRouteKeys` capability.
- `packages/client-runtime/src/state/threads-atoms.test.ts`: the registry fake gets `addRoute`.
- `packages/client-runtime/package.json`: the session package, for its route helpers.
- `packages/client-runtime/src/connection/onboarding.test.ts`: pairing from a link with a relay route.
- `apps/server/src/agentd/relay/loopbackForward.ts`, `relayHost.ts`, `relayHost.test.ts` (ours, from
  `relay-host.md`): forward with the relay address as host; `ws` for the WebSocket, since undici
  drops a Host header.
- `apps/mobile/src/lib/runtime.ts`: the HTTP client and the WebSocket constructor carry relay
  addresses through the relay.
- `apps/mobile/src/connection/platform.ts`: provides `RelayRouteKeys`.
- `apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx`: shows the relay status line.
- `apps/mobile/src/i18n/translations/*.json`: the new strings.
- `apps/mobile/package.json`: the session package.
- `pnpm-lock.yaml`: the new workspace dependencies.
- `docs/user/remote-access.md`: the phone uses the relay when the computer's address fails.
