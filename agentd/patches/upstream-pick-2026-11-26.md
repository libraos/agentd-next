# Upstream picks 2026-11-26

Cherry-picks of upstream T3 Code `96423cb5e2` (#43026, Antigravity usage limits no longer read from Google's internal APIs) and `5e37e6db56` (#43087, Antigravity always identifies as the app and refuses agy 1.5.0), ahead of the next sync. Our builds read no Antigravity or Gemini login files, send no client name of another app and call no internal Google endpoint ([3](3-no-upstream-telemetry.md)).

- `apps/server/src/provider/acp/AntigravityAcpSupport.ts`: the one ACP clientInfo is `agentd-next` / `LibraOS Next`, in place of upstream's `t3-code` / `T3 Code`.
- `apps/server/src/provider/Drivers/AntigravityDriver.ts`: the agy 1.5.0 refusal says "not LibraOS Next".
- `apps/server/src/provider/Drivers/AntigravityDriver.test.ts`, `AntigravityAuth.test.ts`, `acp/AntigravityAcpSupport.test.ts`, `orchestration-v2/Adapters/AntigravityAdapterV2.test.ts`: expectations follow our name.
- `docs/user/providers-antigravity.md`: our text, with upstream's two changes (1.5.1 or newer; Usage shows no Google allowances).
- `agentd/design/outbound.md`: the usage row no longer lists `cloudcode-pa.googleapis.com` or the removed reader.
