# Building AgentD Next

## Cutting a release

1. In one pull request, set the version in `apps/desktop/package.json` (`x.y.z`, ours: minor for features, patch for fixes) and add `docs/release-notes/x.y.z.md`: the list the release notes show under "What's new in x.y.z" and the app's update prompt shows (a Markdown list, one line per change a user notices, a bold label first; see `0.4.1.md`). Merge it. A tag whose version has no notes file fails in the first job, before any build.
2. Tag that commit and push the tag to `origin`: `git tag v0.2.0`, then push `v0.2.0`. A tag that differs from `apps/desktop/package.json` fails the run; a suffixed tag does not run it.
3. `.github/workflows/release.yml` builds on GitHub-hosted runners, in parallel: Linux x64 (`ubuntu-24.04`: AppImage and `.deb`), Windows x64 (`windows-latest`: NSIS `.exe`, MSVC on the runner), macOS arm64 (`macos-26`) and macOS x64 (`macos-26-intel`; Xcode 26, which the Apple Speech helper needs, is their default): `.dmg` and `.zip`. Each runs `agentd/scripts/build-desktop.sh <platform> <arch>` with `AGENTD_BUILD_ON_HOST=1`.
4. A job merges the two macOS `latest-mac.yml` files into one, checks that every installer and `latest.yml`, `latest-linux.yml` and `latest-mac.yml` are there for this version, and writes `SHA256SUMS`. The last job creates a **draft** release for the tag with all of them and the blockmaps. `agentd/scripts/release-notes.sh` writes its notes: the version line with the Engine release inside, What's new from the notes file, then the download, signing and update help every release repeats (who updates in place, and one line for installs still under the app's old name, whose detail is in [Updating](../../docs/user/updating.md)).
5. Review the draft on GitHub (download an installer, check it against `SHA256SUMS`), then publish it as the latest release. Nothing is public until then, and installed apps are offered it only once it is published and marked latest.

agentd inside: the `prepare` job resolves one libraos/engine release for every build, using the dispatch input first, then the `AGENTD_RELEASE` repository variable, then the latest release, and each build downloads that release's asset for its target, `SKILL.md`, `SKILL-agentd.md` and `SHA256SUMS`. The packager refuses an asset that is missing or does not match `SHA256SUMS`.

To try the build without a release, run the workflow by hand (Actions → Release → Run workflow) with N and, optionally, an agentd release: it builds the same files and uploads them, with `SHA256SUMS`, as workflow artifacts.

The job permissions are `contents: read`, except `contents: write` on the job that creates the release and `id-token: write` on the Windows build. Besides `GITHUB_TOKEN`, the only secrets are the Azure ids of the `agentd-signing` environment, which only the Windows build uses, and the Developer ID certificate and App Store Connect key of the `macos-signing` environment, which only the macOS builds use.

### Signing

Windows is signed with Azure Artifact Signing (#280): account `agentd-next-signing`, certificate profile `agentd-public`, subject `CN="Nebula Nova, Inc."`. The Windows build is its own job (`build-windows`), the only one in the GitHub environment `agentd-signing` (deployments from `main` and `v*` tags only) and the only one with an OIDC token: it logs in with `azure/login`, caches a token for the signing endpoint right before the build (the OIDC assertion expires before signing starts; the build step's 40-minute timeout keeps signing inside the token's hour), and sets `T3CODE_DESKTOP_SIGNED` and the `AZURE_TRUSTED_SIGNING_*` variables, from which the packager gives electron-builder `win.azureSignOptions`. A signing error fails the build, but electron-builder builds unsigned when it gets no signing options, and SignTool passes a signature whose timestamp request failed, which stops validating when the three-day certificate expires. So `agentd/scripts/check-windows-signatures.ps1` then fails the job unless the installer and the unpacked `LibraOS Next.exe` carry a valid, timestamped signature from that subject. The publisher name goes into the updater config too: an installed signed app refuses an update not signed by `Nebula Nova, Inc.`, so every later Windows release must be signed by the same subject.

macOS is signed with a Developer ID Application certificate of team `3NP2A75X35` and notarized (#286). The macOS builds are their own job (`build-mac`, both arches), the only one in the GitHub environment `macos-signing` (deployments from `main` and `v*` tags only), whose secrets are `CSC_LINK` (the base64 `.p12`), `CSC_KEY_PASSWORD`, and the App Store Connect API key `APPLE_API_KEY` (the `.p8` text, written to a temporary file for the build), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. With `T3CODE_DESKTOP_SIGNED` the packager signs with the hardened runtime, and electron-builder notarizes and staples the app when the `APPLE_API_*` variables are set. The entitlements are Electron's runtime ones (JIT, unsigned executable memory, no library validation, Apple Events, camera, microphone). The passkey entitlements of upstream's in-app browser need a provisioning profile (`T3CODE_MACOS_PROVISIONING_PROFILE`, `T3CODE_APPLE_TEAM_ID`); without one the app is signed without them and in-app browser passkeys stay off. electron-builder skips notarization without the API key and still succeeds, so `agentd/scripts/check-macos-signatures.sh` then fails the job unless the app in the DMG and in the updater zip has the team's Developer ID signature, Gatekeeper accepts it as notarized, the ticket is stapled, and every Mach-O inside (the engine binary and native modules included) has the hardened runtime and a secure timestamp. A signed build drops the `release-page` update fallback, so notarized installs update in place; installs from before (ad-hoc signed) still open the release page once.

Linux is unsigned and gets no signing variables.

## Mobile

`.github/workflows/mobile.yml` builds the LibraOS Next phone apps (`com.libraos.next`, team `3NP2A75X35`). Its jobs:

- `check` (`ubuntu-24.04`, tags and manual runs): `node scripts/mobile-release-check.ts env`, then the iOS and Android `expo export`, then `node scripts/mobile-release-check.ts bundle` on each. It fails on any upstream endpoint, Clerk or trace setting in the build environment or the bundle, except the entries in `scripts/mobile-release-check.allow.json`.
- `ui-android` (`ubuntu-24.04` with KVM, an API 35 x86_64 emulator) and `ui-ios` (`macos-26`, a simulator): a Release build (Android signed with the debug key), then `apps/mobile/maestro/run-flows.sh`. It starts `scripts/mobile-ui-host.ts`, a scratch server with no LibraOS Engine, and runs the Maestro flows: pair and open LibraOS Engine, revoke on the host and check the phone loses it, and a loopback address that is explained. Dark screenshots and the server log are uploaded. Pull requests that touch `apps/mobile`, `packages` or `scripts/mobile-*` run only these two jobs.
- `ios-release` (`macos-26`) and `android-release` (`ubuntu-24.04`): tags and manual runs only, after `check`, in the GitHub environment `mobile-signing`. iOS imports the distribution certificate into a temporary keychain, archives, exports for App Store Connect and uploads with `xcrun altool`; the build reaches TestFlight. Android builds an `.aab` signed with the upload key and uploads it to Play's internal testing track. Neither job publishes to production: promoting a build is done by hand in App Store Connect and the Play Console.

Every build number is the run number (`T3CODE_MOBILE_BUILD_NUMBER`), and the version follows `apps/desktop/package.json` unless `T3CODE_MOBILE_VERSION` is set.

The secrets of `mobile-signing`: `IOS_DIST_P12` (the base64 `.p12` of the Apple Distribution certificate) and `IOS_DIST_P12_PASSWORD`; `IOS_PROFILE_APP`, `IOS_PROFILE_WIDGETS` and `IOS_PROFILE_SHARING`, the base64 App Store provisioning profiles of `com.libraos.next` and its widget and sharing extensions, made by hand with that certificate (the job sets each target's signing to its profile by bundle id, so the key needs no right to create profiles, and the profiles are renewed yearly); `APPLE_API_KEY` (the `.p8` text, written to a temporary file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, the same App Store Connect key as `macos-signing`; `ANDROID_UPLOAD_KEYSTORE` (the base64 keystore), `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and `ANDROID_UPLOAD_KEY_PASSWORD`; and `PLAY_SERVICE_ACCOUNT_JSON`, a Play service account allowed to release to testing tracks.

To cut a mobile release, tag the commit `mobile-v<version>` (for example `mobile-v0.3.0`, matching the version the build will carry) and push the tag, or run Mobile by hand. Then walk [the release checklist](mobile-release-checklist.md) on the TestFlight and internal-track builds before promoting them.

## Internal test build: Linux AppImage and Windows installer

The internal test build of AgentD Desktop, with agentd inside. Built 2026-11-18 on the Linux build host (x86_64, Ubuntu 22.04, no Rust, Wine, sudo or Windows; Docker available). Nothing was published: no release, tag or upload.

### What was built

| File (in `release/`)                          | Size                        | Target                                           |
| --------------------------------------------- | --------------------------- | ------------------------------------------------ |
| `AgentD-Desktop-0.1.10-agentd.1-x64.AppImage` | 263,330,011 bytes (251 MiB) | Linux x64, unpacked 680 MiB                      |
| `AgentD-Desktop-0.1.10-agentd.1-x64.exe`      | 219,374,582 bytes (209 MiB) | Windows x64, NSIS one-click, unpacked 711 MiB    |
| `AgentD-Desktop-0.1.10-agentd.1-amd64.deb`    | 216,823,528 bytes (207 MiB) | Linux x64; upstream's Linux target also makes it |

Version `0.1.10-agentd.1`: upstream's `apps/desktop/package.json` version, then `-agentd.N` (the scheme before 0.2.0). These builds are on the stable channel (`resolveDesktopUpdateChannel` gives `latest`, so the production icon and name, not nightly ones), and they have no update feed: no `app-update.yml`, so the app's updater says no feed is configured. From 0.2.0 the feed is this repository's releases (patch 144).

What each contains, checked by unpacking it:

- **AppImage:** `resources/agentd/agentd` is the agentd v0.1.13 release asset `agentd-linux-amd64` (sha256 `15c041cd…23f8f4`, as in the release's `SHA256SUMS`; it runs and prints `agentd v0.1.13 0d0b360a58c0`). The launcher `ai.libraos.agentd-desktop.desktop` says `Name=AgentD Desktop`, `X-AppImage-Version=0.1.10-agentd.1`, and its icon `agentd-desktop.png` (hicolor 16 to 512 px) is the AgentD mark. Also the resource monitor, KDE and Hyprland capture helpers and the browser secret helper, all built from source in the container.
- **Windows installer:** `$PLUGINSDIR/app-64.7z` holds `AgentD Desktop.exe` and `resources/agentd/agentd.exe`, the v0.1.13 release asset `agentd-windows-amd64.exe` (sha256 `992ee3f4…ca9bf7`, as in `SHA256SUMS`). The icon resource of both `AgentD Desktop.exe` and the installer is the AgentD mark (7 sizes, 16 to 256 px). `resources/resource-monitor/t3-resource-monitor.exe` is built with MinGW (see below).

### How

```sh
pnpm install                             # Node 26.13.1 (package.json engines)
agentd/scripts/build-desktop.sh linux    # 2 min 40 s here once the image exists (first image build: about 2 min more)
agentd/scripts/build-desktop.sh win      # 1 min 40 s here
agentd/scripts/build-desktop.sh mac [arm64|x64]  # on a Mac only, on the host; arch defaults to the Mac's
```

`agentd/scripts/build-desktop.sh` sets the version (`AGENTD_BUILD_N`, default 1), downloads the agentd release (`AGENTD_RELEASE`, default the latest of `libraos/engine`) with `gh` into `release/agentd-dist/<tag>` (the binary for the target, `agentd-linux-amd64`, `agentd-windows-amd64.exe`, `agentd-darwin-arm64` or `agentd-darwin-amd64`, both Skills and `SHA256SUMS`) unless `AGENTD_DIST_DIR` names one, clears the update repository variables, and runs upstream's packager `scripts/build-desktop-artifact.ts --platform linux|win --target AppImage|nsis --arch x64`. The packager checks each agentd asset against `SHA256SUMS` before bundling it (task #15).

It runs the packager in a container, because the host lacks what upstream's build needs and has no sudo to install it:

- Base: electron-builder's Wine image, `electronuserland/builder:wine` pinned as `sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe` (Ubuntu 22.04, Wine 11.0, libsecret headers).
- Added once (image `agentd-desktop-builder:<hash of the Dockerfile>`): Rust 1.100.0 with the Linux and `x86_64-pc-windows-gnu` targets (`sysinfo` 0.39 needs Rust 1.95 or newer), MinGW-w64, ImageMagick, and Electron's runtime libraries (the packager runs the packaged Linux app to fill its compile cache).
- The host's Node, the pnpm store, the git directory and the agentd assets are mounted; the repository is mounted at `/w`. The container runs as the calling user, with its home (Electron and electron-builder caches, Wine prefix, Cargo registry) in `release/.agentd-build-home`.

`AGENTD_BUILD_ON_HOST=1` skips the container on a host that has upstream's prerequisites (Linux: cargo, cc, make, libsecret-1-dev, ImageMagick; Windows: upstream's Windows build tools, run from Git Bash; macOS: Xcode's command line tools and Rust with the target). `mac` always builds on the host: the container cannot make a `.dmg`.

#### Resource monitor without Rust on the host

No upstream change: the container has Rust, so the Linux build compiles the monitor with `cargo` as upstream does. MSVC does not exist off Windows, so for Windows the script compiles it with MinGW (`--target x86_64-pc-windows-gnu`), copies the `.exe` to the MSVC target directory the packager reads, and sets upstream's `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1`.

#### Windows on Linux

electron-builder makes the NSIS installer with its own Linux `makensis` and uses Wine for `rcedit` (icon and version resources) and for the uninstaller. Two things had to give:

- **makensis crash.** electron-builder's bundled makensis 3.0.4.1 stops with `*** stack smashing detected ***` on an `!include` path of about 285 characters. The path to pnpm's patched `app-builder-lib` templates under a deep checkout reaches that; with the repository mounted at `/w` it does not. Reproduced with a two-line script.
- **glibc check.** On Linux, upstream's packaged-payload check (`scripts/linux-glibc.ts`) fails on any `readelf` stderr, and readelf 2.38 (Ubuntu 22.04) warns about the split-debug links in Electron's `libvulkan.so.1`. It now passes `-wN` (do not follow those links), which leaves the version information it reads unchanged.

Not verified on Windows (no Windows host was used): that the installer installs and the app starts, that the MinGW resource monitor and the bundled `agentd.exe` run, and upstream's Windows-only checks, which the packager skips off Windows (native-module load probe, bundle self-check). The release workflow builds Windows natively on `windows-latest` instead.

### Not done here

- No signing at the time: the builds were unsigned (`T3CODE_DESKTOP_SIGNED` off); see Signing for what is signed now.
- No Linux or Windows arm64 builds.
- The Linux launcher still registers the upstream `t3code` URL scheme; that is the rebrand's region (#2), not this task's.
