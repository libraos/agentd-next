# 286: macOS builds signed with a Developer ID and notarized

- `.github/workflows/release.yml`: the macOS builds move to their own `build-mac` job, the only one in the `macos-signing` environment. It sets `T3CODE_DESKTOP_SIGNED`, the `CSC_*` certificate variables and the `APPLE_API_*` notarization key (the `.p8` written to a temporary file), then fails unless `agentd/scripts/check-macos-signatures.sh` finds the app in the DMG and the updater zip signed by team `3NP2A75X35`, notarized, stapled, and every Mach-O inside hardened and timestamped. The release notes say macOS is notarized, and that installs from before update by hand once.
- `scripts/build-desktop-artifact.ts`: a signed macOS build no longer requires upstream's passkey provisioning profile. Without `T3CODE_MACOS_PROVISIONING_PROFILE` it signs with Electron's runtime entitlements only (`renderMacRuntimeEntitlements`), and in-app browser passkeys stay off; with one, the passkey entitlements are added as before.

`README.md` and `docs/user/install.md` keep their "not notarized" steps until a notarized release is public. See [Signing](../design/build.md#signing).
