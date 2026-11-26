# The Windows payload limit after the 2026-11-25 upstream sync

The Windows release on `main` failed `validateWindowsPackagedPayload` with 108 loose files against
a limit of 100 (the `v0.4.0` tag build had 99). The NSIS file lists of the two CI builds differ only
in `resources/server-compile-cache`: 29 files at the tag, 38 on `main`. That directory holds one V8
bytecode cache entry per server chunk loaded at startup, plus its manifest, and the sync split the
server bundle into 9 more such chunks. The cache speeds up every launch, so it ships.

The payload also carried two unused copies of the resource monitor in `app.asar.unpacked`; the app
runs only `resources/resource-monitor`. They are now left out of the ASAR on every platform, so the
Windows payload is 106 files and the limit is 108.

## Upstream files changed

- `scripts/build-desktop-artifact.ts`: the app's `files` leave out `apps/desktop/{resources,prod-resources}/resource-monitor`;
  the Windows file limit is 108, with a comment naming the compile cache entries.
- `scripts/build-desktop-artifact.test.ts`: a test that the resource monitor ships only as an extra resource.
