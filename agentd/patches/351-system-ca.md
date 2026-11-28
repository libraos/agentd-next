# 351 — Gateways with an internal CA: trust the system certificate store, without a restart

A custom gateway whose certificate comes from an internal CA needed Next started with `NODE_EXTRA_CA_CERTS`, and failed with "Couldn't reach … Check your connection".

- At start the server trusts the system certificate store beside the roots Node started with (`tls.setDefaultCACertificates`, which Node's `fetch` reads), and sets `NODE_USE_SYSTEM_CA=1` in its own environment, so every agent it starts (Pi, Claude Code, opencode, ...) inherits it. An explicit `NODE_USE_SYSTEM_CA` is kept. Codex does its own TLS and is not affected.
- Node reads the system store once per process. When a custom gateway's model list fails on an untrusted certificate (adding, testing or refreshing it), the server reads the store again in a child process (`__system-certificates`, the same fast-path way as `__document-text`), trusts the result and asks once more. A CA installed while Next runs works without a restart; an agent's next session reads the store itself.
- A certificate failure says the gateway's certificate isn't trusted and, for an unknown issuer, to add the CA to this computer's certificate store; other failures still say "Check your connection".

Ours: `apps/server/src/agentd/systemCertificates.ts` (+ test), `apps/server/src/gateway/gatewayKeyModels.ts` (certificate answer, + test), `CustomGateway.ts` (re-read and retry) and `CustomGateway.test.ts`. The first version (#352) read the store only at start and asked for a restart; this one replaces it in the same module.

## Upstream files changed

- `apps/server/src/binCli.ts` — Trust the system store and set `NODE_USE_SYSTEM_CA` for agents at start, beside the other outbound HTTP setup.
- `apps/server/src/binMain.ts` — `__system-certificates` fast path that prints the system store, for the re-read.
- `docs/user/welcome-page.md` — A gateway signed by an organization's CA works once the CA is in the system store, without a restart.

Tested on Linux (the re-read test uses `SSL_CERT_FILE`, which only Linux's store reads); macOS and Windows use Node's own store readers, untested here.
