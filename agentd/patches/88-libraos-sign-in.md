# 88: LibraOS Gateway, sign in with LibraOS instead of pasting a key

Builds on #80. The Gateway panel (Welcome → Use an API key or gateway → LibraOS Gateway, and Settings → Providers, which shows the same chooser) leads with **Sign in with LibraOS**; the key field from #80 is behind "Use an API key instead".

Sign-in is the device flow of libraos/cloud#524 (client `agentd-desktop`): the server asks `POST https://console.libraos.com/v1/device/code` (Cloud serves the flow on Console's origin; `app.libraos.com` redirects these routes to the sign-up page), the panel shows the code and the sign-in page (the desktop opens it with its open-external path; the web build shows the link, since a browser blocks a window opened after an await), and the person signs in or creates an account there and approves the code. The server polls `/v1/device/token` at Cloud's interval, five seconds slower after each `slow_down`, keeps polling through a failed request, and stops at the code's expiry, on `access_denied` or on Cancel, each with one line and Try again. With the token it calls `POST /v1/gateway-keys` (name "LibraOS Next on <host name>") and hands the `lk_…` key to #80's connect: the same model check, storage, `agentd init --model-key` and Gateway agents, including #203's Pi agent and its first-run default. #241's custom gateways are separate services and untouched. If that connect fails, the new key is revoked again with the same token and anything written here is removed. The part after the token cannot be interrupted, so Cancel never leaves a key half-connected.

The session token lives only in the sign-in's fiber: it is not stored, logged or sent to a client (a test checks that no stored secret contains it). The key's id, the account email and workspace from the token answer are stored beside the key in the server secret store (`libraos-gateway-account`); the connected panel shows the email and workspace.

## Disconnect and the session token

`DELETE /v1/gateway-keys/{id}` takes only a device sign-in token, and #88 says the token is dropped after making the key. So Disconnect on a key made by sign-in runs a second, short device sign-in ("To revoke the key in LibraOS, … approve this code"), revokes the key with that token, then does #80's disconnect, and the panel says "The key was revoked in LibraOS." If revoking fails (refused, expired, denied) the key is still removed here and the panel says it is still active in LibraOS and to revoke it on Console's API keys page. Cancel leaves it connected; "Remove here only" removes it here without revoking and says the same. A pasted key disconnects as in #80. If one approval is wanted instead, Cloud would need to let a key revoke itself (or the app would need to keep the token, which #88 rules out).

## Upstream files changed

- `packages/contracts/src/rpc.ts`: Add the `libraosGateway.signInStart`, `.signInWait` and `.signInCancel` RPCs.
- `packages/contracts/src/clientRpcPermissions.ts`: The three sign-in RPCs need the environment-maintain scope, as connect does.
- `apps/server/src/observability/RpcInstrumentation.ts`: Name the three RPCs' span group.
- `apps/server/src/ws.ts`: Route the three RPCs to the Gateway service.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx`: The Gateway panel's sign-in, waiting-for-approval and revoke views; the key form behind "Use an API key instead".
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx`: Sign-in is the first view; the key field opens from "Use an API key instead".

Ours: `packages/contracts/src/libraosGateway.ts`, `apps/server/src/gateway/` (`deviceSignIn.ts` new, `LibraosGateway.ts` and its test), `apps/web/src/lib/libraosGatewayState.ts`.

## Windows, macOS and Linux

The new code is HTTP and in-memory state only: no paths, processes or shell beyond #80's connect, which it reuses. The host name comes from Node's `os.hostname()`.

Checked on Linux (2026-11-25), after merging main with #203's Pi agent and #241's custom gateways: typecheck of contracts, server and web; the server, contracts and web test suites; the gateway tests (sign-in with `authorization_pending` and `slow_down`, denial, expiry, Cancel, a key the Gateway refuses being revoked again, revoke on disconnect, every Gateway agent including Pi added and removed) against a faked Cloud; the welcome browser test; `vp run i18n:check`.

Live Cloud: #524 is deployed on `console.libraos.com` (`app.libraos.com` 302s `/v1/device/code` to the sign-up page, which is why the origin moved). Against it, `POST /v1/device/code` for client `agentd-desktop` answered a code our parser reads (15 minutes, 5-second interval), `/v1/device/token` answered `authorization_pending` as the poll expects, and `/v1/gateway-keys` without a token answered 401. One real sign-in was started (code MKKH-PDSM, polled with our `readTokenAnswer`) and offered to a person to approve; nobody approved it, and Cloud's expiry answer was read as "The sign-in code expired before it was approved." So no real approval, sign-up, key creation, model listing with a made key, or revoke ran on any system, and the token answer's `email` and `workspace` fields are taken from #524's text, not seen.

Not verified on macOS or Windows at all: the desktop opening the sign-in page in the default browser, the sign-in and revoke through the app's panel, and #80's Windows items (the `icacls` ACL on LibraOS Core's key file) still stand. No chat through a signed-in key was run on any system.
