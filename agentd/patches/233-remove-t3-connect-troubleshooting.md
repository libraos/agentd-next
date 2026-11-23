# 233: Remove upstream's T3 Connect troubleshooting page and the links to it

`docs/user/t3-connect-troubleshooting.md` described upstream's hosted relay (T3 Connect), which
this build turns off (`HOSTED_RELAY_ENABLED = false`, patch 85). The user decided to delete it
(dec-a8467e8901). Its relay diagnostics linked "More info" to upstream's copy of the page on
github.com/pingdotgg/t3code; those links pointed our users at a service the app does not use, so
they are gone too. Each message keeps its reason, hint and fix and stands on its own.

## Upstream files changed

- `docs/user/t3-connect-troubleshooting.md`: deleted.
- `packages/contracts/src/environmentHttp.ts`: removed `T3_CONNECT_TROUBLESHOOTING_SECTIONS`,
  `t3ConnectTroubleshootingUrl` and `connectReachabilityHelpUrl`.
- `packages/client-runtime/src/connection/diagnosis.ts`: the connection diagnosis has no
  `moreInfoUrl`; the copied diagnostics text has no "More info" line.
- `packages/client-runtime/src/connection/diagnosis.test.ts`: dropped the help-link assertions.
- `apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx`: no "More info" link.
- `apps/web/src/components/settings/SavedEnvironmentRows.tsx`: the relay reachability failure has
  no "More info" link.
- `apps/mobile/src/features/connection/ConnectionDiagnosisDetails.tsx`: no "More info" button.
- `apps/server/src/cloud/ConnectReachability.ts`: the CLI and log diagnosis has no "More info" line.
- `apps/server/src/cloud/ConnectReachability.test.ts`: removed the test that read the page's headings.
- `.github/scripts/ci-changes.cjs`, `scripts/check-changed.ts`, `scripts/check-changed.test.ts`: no
  CI routing for the page; the test now checks only that user docs select nothing.
- `apps/{web,mobile}/src/i18n/translations/*.json`: the unused "More info" key, regenerated.
