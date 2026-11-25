# 280: Windows installers signed with Azure Artifact Signing

- `.github/workflows/release.yml`: Windows builds in its own `build-windows` job, the only one in the `agentd-signing` environment and with `id-token: write`. It logs in with `azure/login`, sets `T3CODE_DESKTOP_SIGNED` and the `AZURE_TRUSTED_SIGNING_*` variables the packager already reads, and fails unless the installer and the unpacked app carry a valid `Nebula Nova, Inc.` signature. The release notes say Windows is signed.

The packager (`scripts/build-desktop-artifact.ts`) is unchanged: it already turns those variables into electron-builder's `win.azureSignOptions`. See [Signing](../design/build.md#signing).
