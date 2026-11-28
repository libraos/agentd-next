# 351 — Gateways with an internal CA: trust the system certificate store

Node trusts only its bundled roots and `NODE_EXTRA_CA_CERTS`, so a custom gateway whose certificate comes from an internal CA failed until Next was restarted with that variable. The server now also trusts the system certificate store, and the agents it starts get `NODE_USE_SYSTEM_CA=1`. A certificate failure while reading a gateway's models says the certificate isn't trusted instead of "Check your connection". Node caches the system store per process, so a CA installed while Next runs still needs one restart.

- `apps/server/src/binCli.ts`: calls `trustSystemCertificates()` at start, beside the other outbound HTTP setup.
- `docs/user/welcome-page.md`: a gateway behind your own CA needs the CA in the system store and one restart.
