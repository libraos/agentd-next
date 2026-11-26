# Mobile v1: LibraOS Next for iOS and Android, direct pairing

Upstream's Expo app ships as LibraOS Next. It connects only by direct pairing (LAN, Tailscale or
another VPN, a public URL), reaches no upstream service, and shows LibraOS Engine read-only. The
Clerk library stays in the bundle but cannot be reached while `HOSTED_RELAY_ENABLED` is off;
removing it would fight every upstream sync.

## Upstream files changed

- `apps/mobile/app.config.ts`: ids `com.libraos.next(.dev|.preview)`, Apple team `3NP2A75X35`,
  slug `libraos-next`, no `owner`, updates off with no feed, no EAS project id, no Clerk extras,
  no default trace endpoint, the `@clerk/expo` plugin only with the hosted relay, and the version
  follows `apps/desktop/package.json` unless `T3CODE_MOBILE_VERSION` is set.
- `apps/mobile/app.config.test.ts`: the new ids and the absence of every upstream service.
- `apps/mobile/eas.json`: no `channel` or `environment` of upstream's EAS project, no App Store
  app id, no pinned TestFlight version.
- `apps/web/public/.well-known/apple-app-site-association.json`: our team and ids.
- `apps/web/public/.well-known/assetlinks.json`: empty; no hosted web app exists and the Play
  signing fingerprint is not known yet.
- `apps/mobile/src/features/settings/lib/legal-document-url.ts`: the Legal page opens this build's
  telemetry notice, as web's privacy link does, instead of upstream's marketing site.

Ours: `scripts/mobile-release-check.ts` (`env` and `bundle DIR` modes), its test and
`scripts/mobile-release-check.allow.json`.
