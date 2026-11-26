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
- `apps/mobile/src/Stack.tsx`: the `SettingsEngine` route (`settings/engine/:environmentId`),
  titled LibraOS Engine. Its name starts with `Settings` so it opens as a Settings page.
- `apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx`: a LibraOS Engine
  row on a connected environment this device may read.
- `apps/mobile/src/features/home/home-empty-state.ts`, `apps/mobile/src/features/layout/WorkspaceEmptyDetail.tsx`:
  with no environment, the first screen asks to pair with your computer and says how.
- `apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx`: without a relay,
  says notifications arrive while the app is open.
- `apps/mobile/src/features/connection/pairing.ts` and its test, `apps/mobile/src/state/use-remote-environment-registry.ts`:
  a failed pairing with a loopback address says it reaches only the phone. It is tried first
  because a simulator's loopback is the computer.
- `apps/mobile/src/i18n/translations/*.json`: the new strings, translated.
- `docs/user/install.md`, `remote-access.md`, `telemetry.md`: name the phone apps; they send
  nothing by default.

Ours: `apps/mobile/src/state/agentd.ts`, `apps/mobile/src/features/engine/` (the read-only
LibraOS Engine screen: tasks by section, Stop for a device with operate permission, approvals
listed to answer on the computer), `scripts/mobile-release-check.ts` (`env` and `bundle DIR` modes), its test and
`scripts/mobile-release-check.allow.json`, `scripts/mobile-ui-host.ts` (the server UI tests
pair with, with no LibraOS Engine) and its test, `apps/mobile/maestro/` (the UI test flows).
