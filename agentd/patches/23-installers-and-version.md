# 23: Linux and Windows installers, and our version scheme

Upstream files changed:

- Version: patch 144 replaced the `x.y.z-agentd.N` scheme with our own `x.y.z` in `apps/desktop/package.json`; `scripts/lib/tagged-source-version.ts` and the packager's version lines are upstream's again.
- `scripts/linux-glibc.ts` (not in the task's list, one argument): `readelf` gets `-wN` so binutils 2.38 (Ubuntu 22.04) does not print split-debug warnings for Electron's `libvulkan.so.1`, which the check counted as a failure; the version information it reads is the same.

New, ours: `agentd/scripts/build-desktop.sh linux|win` and `agentd/design/build.md` (commands, contents, sizes).

Resource monitor without Rust on the host: neither option the task offered was needed in upstream code. The script runs the packager in a container that has Rust, so Linux builds the monitor with `cargo` as upstream does. For Windows, MSVC is not available off Windows, so the script builds the monitor with MinGW (`x86_64-pc-windows-gnu`) and hands it to the packager through the existing `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR` at the MSVC path it reads.

Windows: the NSIS installer is built on Linux in electron-builder's Wine image (pinned by digest), with the repository mounted at `/w` because electron-builder's bundled makensis 3.0.4.1 crashes on include paths of about 285 characters (see `agentd/design/build.md`). Not verified on Windows: that the installer runs, that the MinGW resource monitor and the bundled `agentd.exe` start, and the packager's native-module probe and bundle self-check, which upstream skips off a Windows host.
