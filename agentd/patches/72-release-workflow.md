# 72: release workflow: installers for macOS, Windows and Linux in a draft release (unsigned)

**The new `.github/workflows/release.yml` has not run.** No push or Actions run was possible here. What
only the first real run can show is listed at the end.

Upstream files changed:

- `scripts/build-desktop-artifact.ts` (one expression in the `mac` config): an unsigned macOS build gets
  `identity: "-"`, `hardenedRuntime: false` and `notarize: false`, so electron-builder signs it ad-hoc and
  never notarizes. Signed builds are unchanged (they still go through `scripts/sign-macos.ts`).
- `scripts/build-desktop-artifact.test.ts`: the existing macOS config case also asserts those three values
  for unsigned builds and no `identity` for signed ones.

New or ours: `.github/workflows/release.yml`; `agentd/scripts/build-desktop.sh` (`mac [arm64|x64]`,
downloads only the target's agentd asset, Windows path through `pwd -W`); `agentd/design/build.md`
("Cutting a release", "Unsigned builds"); the README's "Build the installers".

## Unsigned macOS: what and why

The packager already sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and drops `CSC_LINK` and `APPLE_API_*` when
not `--signed`, so no certificate is looked for. Left there, electron-builder skips signing entirely, and an
Apple Silicon Mac calls an app whose bundle no longer matches Electron's own signature "damaged", with no
way to open it from Finder. With `identity: "-"` electron-builder (26.16, `MacTargetHelper.findSigningIdentity`)
signs ad-hoc instead, so macOS shows "unidentified developer" and right-click → Open works. The hardened
runtime is off because, ad-hoc signed, library validation would refuse the app's native modules (no Team
ID); electron-builder warns about exactly that combination. `notarize: false` makes the skip explicit.

## Workflow

- Triggers: tag `vX.Y.Z` and `workflow_dispatch` (input `agentd_release`). The tag must equal
  `apps/desktop/package.json`'s version, or the run fails at once (patch 144; before it, `v*-agentd.*`).
- `prepare` resolves the version and one agentd release for all builds (input, else the `AGENTD_RELEASE`
  repository variable, else the latest of libraos/agentd).
- `build` matrix: `ubuntu-latest` linux x64, `windows-latest` win x64, `macos-14` mac arm64,
  `macos-15-intel` mac x64. The task named `macos-13`; GitHub retired that image in December 2025, and
  `macos-15-intel` is its Intel replacement. Each installs Rust 1.100.0 (as the local Docker image) with the
  target, and runs `build-desktop.sh` on the host. Blockmaps and `latest*.yml` are uploaded (patch 144).
- `checksums` fails unless the AppImage, `.deb`, `.exe` and both `.dmg` are there, then writes `SHA256SUMS`
  over every installer (the macOS `.zip` files too) and uploads it as an artifact, so a dispatch run has it.
- `release` (tag pushes only, the one job with `contents: write`) checks `SHA256SUMS` and runs
  `gh release create --draft --verify-tag` with notes on unsigned macOS and Windows and the agentd version.
- No `pull_request_target`, no secrets beyond `GITHUB_TOKEN`, actions pinned by SHA (the same pins as
  `ci.yml` and upstream's old release workflow).

## Windows

Built natively on `windows-latest` from Git Bash: the MinGW cross path in `build-desktop.sh` runs only
inside the Docker container, so the runner builds the resource monitor with MSVC as upstream does. The
script gives Node a Windows path for `AGENTD_DIST_DIR` (`pwd -W`). Not verified: the run itself, and that the
installer installs and the app starts.

## Verified here

- `bash -n` on the script; the workflow parses as YAML and has the four jobs and both triggers.
- `agentd/scripts/build-desktop.sh linux` and `win` with Docker, after the change, on the Linux build host:
  both passed (`AgentD-Desktop-0.1.10-agentd.1-x64.AppImage`, `-amd64.deb`, `-x64.exe`), each fetching only
  its own agentd asset (v0.1.13) and bundling it after the `SHA256SUMS` check.
- `build-desktop.sh mac` off macOS, and `linux arm64` / `win arm64`, stop with exit 2 and a usage line.
- The packager test above.
- actionlint was not run (no binary on this host).

## Only the first real run can show

- That each runner has what the packager's preflight wants: `windows-latest` MSVC with the Spectre
  libraries and Python for node-gyp; `macos-14` and `macos-15-intel` Xcode tools, `sips`, `iconutil`;
  `ubuntu-latest` (24.04) packages named in the workflow.
- That `macos-15-intel` is available to this repository, and the arm64 and x64 `.dmg` build there.
- That electron-builder ad-hoc signs (log line `identityName=-`) and the `.dmg` opens with right-click →
  Open on Apple Silicon and Intel, not "damaged".
- That `setup-vp` installs dependencies on Windows and macOS as it does on Linux in `ci.yml`.
- That `gh release download` from libraos/agentd works with this repository's `GITHUB_TOKEN`, and
  `gh release create --draft` makes the draft with all eight files.
- That Windows Git Bash runs `build-desktop.sh` end to end (path handling, `ls` of the output).
- `.github/workflows/release.yml`: the Linux build runs on `ubuntu-24.04`, not `ubuntu-latest` (now 26.04 with glibc 2.42, above the 2.39 ceiling the build enforces).
- `.github/workflows/release.yml`: macOS arm64 builds on `macos-15`; GitHub no longer runs `macos-14` jobs.
- `scripts/build-desktop-artifact.ts`: the Windows payload file limit is 100, not 80; the bundled agentd, its Skills and our resources bring the payload to 93 files. The limit still catches a node_modules tree packed in by mistake (thousands of files).
