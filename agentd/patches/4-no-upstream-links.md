# 4: Updates, install scripts and hosted links do not point at upstream

This build has no default release source. Updates, the npm release lookup, the SSH runner's
download and the install scripts work only when `T3CODE_RELEASE_BASE_URL` (or a managed
policy's update mirror) names a mirror laid out like GitHub's `releases/download`. Without
one they say "Updates are not configured for this build" (or the SSH/installer equivalent)
and make no network request.

## Upstream files changed

- `packages/shared/src/cliRelease.ts`: removed the upstream repository, its releases page,
  the GitHub release index URL and the default download base; added
  `UPDATES_NOT_CONFIGURED_REASON` and `cliReleaseBaseUrl` (no default).
- `apps/server/src/cli/update.ts`: `t3 update` refuses before any request without a mirror; the
  newest version comes from the mirror's feed file (as for a policy mirror), not GitHub.
- `apps/server/src/cloud/selfUpdate.ts`: remote (boot-service) updates refuse without a mirror.
- `apps/server/src/cloud/npmRelease.ts`: the npm `t3` lookup (upstream's package) refuses
  without a configured release source.
- `apps/server/src/cloud/pinnedRuntime.ts` (not owned, 7 lines): a runtime download without a
  release source fails with a clear step instead of using a default URL. `t3 service install`
  in bootService.ts reaches this path.
- `packages/ssh/src/tunnel.ts`: the remote runner stops with "This build has no t3 release
  source" when it would download without a mirror; no `t3.codes` install hint.
- `apps/server/src/cli/install.ts`, `apps/server/src/cloud/servicePreflight.ts`: no install
  script URL in the messages.
- `apps/web/src/components/InstallT3Commands.tsx`: shows only the `t3` command and says this
  build has no install script yet.
- `scripts/install.sh`, `scripts/install.ps1`: require `T3CODE_RELEASE_BASE_URL` and
  `T3CODE_VERSION`; no GitHub release lookup, no `t3.codes` links.
- `apps/mobile/src/features/settings/environment-maintenance.ts` (not owned, needed by the
  removed exports): the mobile release check reports "Updates are not configured for this
  build." without a request.
- `apps/desktop/src/app/DesktopStartupRecovery.ts`: no releases-page links; the Reinstall and
  Releases offers tell the user to reinstall, with no button.
- `apps/web/src/components/desktopUpdate.logic.ts` (+ `sidebar/SidebarUpdateReleaseNotes.tsx`,
  3 lines): release links exist only with a valid `T3CODE_DESKTOP_UPDATE_REPOSITORY`.
- `apps/web/src/lib/bootError.ts`: removed the upstream download and GitHub issue links.
- `apps/web/src/legalLinks.ts`: points at this repository's `docs/user/telemetry.md`; the
  consumers (WelcomePage, SettingsPanels) belong to tasks 11 and 05.

- `packages/shared/src/connectAuth.ts`: `DEFAULT_HOSTED_APP_URL` is `undefined`; this build has
  no hosted app.
- `packages/shared/src/providerAuthReturnUrl.ts`: only a loopback web client is a return target.
- `packages/shared/src/threadLinks.ts`: copied thread links are `<t3-thread://v2/…>` (they open
  in T3 Code and paste back as a chip); hosted links are written and read only with a hosted
  origin, and upstream's hosted links are left as plain text.
- `packages/shared/src/promptLinks.ts`: new-thread links use `t3code://new`; no https link maps
  to an app path without a hosted app.
- `apps/web/src/hostedPairing.ts`: no hosted pairing link (Connections falls back to the direct
  `/pair` link); `isHostedStaticApp` is false unless the build sets `VITE_HOSTED_APP_URL`.
- `packages/client-runtime/src/threadReference.ts`, `apps/mobile/src/App.tsx`: accept an unset
  hosted URL.
- `apps/server/src/cloud/publicConfig.ts` (also task 03's): `T3CODE_HOSTED_APP_URL` has no
  default and the nightly hosted URL is gone. `auth/McpOAuth.ts` then gives outside MCP clients
  t3-thread links, and `auth/mcpOAuthHttp.ts` approves agent sign-ins on the server's own
  `/connect-agent` page.
- Not owned by any task, one line each: `policy/policyTemplates.ts` (label),
  `project/ManagedProjectFolders.ts` (README footer link), `settings/MultipleAccountsNote.tsx`
  (FAQ now links this repository's docs).

Tests updated to the new behaviour: update, selfUpdate, npmRelease, pinnedRuntime,
servicePreflight, SSH tunnel, install scripts, mobile environment maintenance, desktop
startup recovery, desktopUpdate.logic, thread and prompt links, composer references, Codex
handoff, thread reference, hosted pairing, McpOAuth, mobile app config. `packages/ssh/src/tunnel.test.ts` also passes PATH to
the archive-launch scripts: they exec `node`, which is not on sh's default PATH here, and
two of those tests failed on base for that reason.

## Desktop auto-update

`scripts/build-desktop-artifact.ts` writes a publish feed only when
`T3CODE_DESKTOP_UPDATE_REPOSITORY` is set. `agentd/scripts/build-desktop.sh` sets it to our own
releases, `libraos/agentd-next` (patch 144), never upstream's.

## Remote hosts

The desktop app installs the server on an SSH host by downloading the release archive
(`DesktopSshEnvironment.ts` always uses archive mode outside development). Shipping the
desktop app's own copy is a larger change, so this build reports "not available yet" unless a
mirror is configured.

## Windows

No paths, shells or commands were added to product code; URLs are built with `URL`. `install.ps1` got the same change as
`install.sh`; its tests run only on Windows and were not run here.

## URLs left in other tasks' files

- `apps/web/src/branding.ts` (task 02/03): `t3.codes/download`, `t3.codes/mobile`.
- `apps/server/src/provider/ModelManifest.ts`, `telemetry/AnalyticsService.ts`,
  `triage/*`, `cloud/publicConfig.ts`, `web/.../GitHubStarPrompt.tsx` (task 03).
- `docs/user/telemetry.md` names `ingest.t3.codes` (task 03).
- `packages/contracts/src/environmentHttp.ts:526` links upstream's T3 Connect troubleshooting
  doc (outside the Accept grep; T3 Connect only).
- `apps/mobile/app.config.ts` still lists `app.t3.codes` for associated domains; its test pins
  that host by name.
- `apps/web/src/components/cloud/TunnelUsage.tsx`: `t3.chat` subscription link, shown only
  for T3 Connect (needs cloud config built in); not a t3.codes URL, left as is.
