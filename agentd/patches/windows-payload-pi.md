# The Windows payload stays under its file limit with Pi bundled

LibraOS Next 0.3.0's Windows release failed `validateWindowsPackagedPayload` with 107 loose files
against a limit of 100 (0.2.3 had exactly 100). The 7 new files came from the shipped Pi
(`@earendil-works/pi-coding-agent`). Five were quickjs-wasi's WebAssembly extensions, which are
named `.so` and were matched by the server sidecar's `**/*.so` unpack glob. The other two were
pi-tui's win32-x64 and win32-arm64 prebuilds. The limit stays at 100. Those files stay packed
or are dropped, along with ffi-rs's ia32 addon, which never loads on an x64 or arm64 build.

## Upstream files changed

- `scripts/build-desktop-artifact.ts`: the sidecar unpacks only `.dll` and `.exe` plus PE `.node`
  files. The other-architecture `prebuilds/win32-*` ignore covers every package, not only node-pty.
  The sidecar and the app both leave out `@yuuang/ffi-rs-win32-ia32-msvc`.
- `scripts/build-desktop-artifact.test.ts`: the architecture packing test covers Pi's prebuilds,
  the WebAssembly `.so` and the ia32 addon.
