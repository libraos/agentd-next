# 144: Updates come from our releases, and the version is our own

Before this, builds had no update feed, so **Check for Updates** was disabled and the app never offered a new version. Upstream's updater already checks 15 seconds after launch and every 4 hours, and asks before downloading and installing. This patch gives it a feed: the GitHub releases of `libraos/agentd-next`.

Upstream files changed:

- `apps/desktop/package.json`: the version is ours (`0.2.0`), not upstream's. Keep ours in a sync.
- `scripts/build-desktop-artifact.ts`: drops the `x.y.z-agentd.N` exception, so a release build gets the publish config; an unsigned macOS build gets `agentdUpdateInstall: "release-page"` in its package metadata.
- `scripts/build-desktop-artifact.test.ts`: that marker, set for unsigned and not for signed macOS builds.
- `scripts/lib/tagged-source-version.ts` and its test: back to upstream's (patch 23's `-agentd.N` rule removed).
- `apps/desktop/src/updates/DesktopUpdates.ts`: with that marker, Download opens the release page for the offered version instead of downloading. Squirrel.Mac installs only an update signed like the running app, which an ad-hoc signed build cannot satisfy.
- `apps/desktop/src/updates/updatesTestHarness.ts` and `DesktopUpdates.test.ts`: a fake `ElectronShell` and readable files, and the release-page case.

Ours: `agentd/scripts/build-desktop.sh` sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` to `libraos/agentd-next` (`AGENTD_UPDATE_REPOSITORY` overrides it; empty means no feed) and takes the version from `apps/desktop/package.json`. With a feed the AppImage is `AgentD-Next-x86_64.AppImage`, the name `latest-linux.yml` lists, so the updater replaces it in place. `.github/workflows/release.yml` runs for `vX.Y.Z` tags only, uploads blockmaps and `latest*.yml`, and merges the two macOS manifests with upstream's `scripts/merge-update-manifests.ts`.

Not offered as updates: drafts, prereleases, workflow_dispatch runs (artifacts only) and `x.y.z-preview.<yyyymmdd>.<n>` builds, which get no feed at all. Installs of `0.1.10-agentd.8` and earlier have no feed and need `0.2.0` installed by hand once.
