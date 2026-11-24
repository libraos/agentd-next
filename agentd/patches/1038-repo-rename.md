# Renamed GitHub repositories (libraos/core#1038)

The repositories were renamed (dec-73fdb8afdd): `libraos/agentd` is `libraos/cli` (LibraOS Core's binaries, installers and dash), `libraos/agentd-next` is `libraos/next` (this app) and `libraos/agentd-core` is `libraos/core`. GitHub redirects the old names; nothing here relies on that. The update feed (`agentd/scripts/build-desktop.sh`'s `T3CODE_DESKTOP_UPDATE_REPOSITORY` default) is now `libraos/next`, and the bundled Core release comes from `libraos/cli`.

Upstream files changed:

- `.github/workflows/release.yml`: the bundled Core release is looked up in `libraos/cli`.
- `CONTRIBUTING.md`, `README.md`, `apps/marketing/README.md`, `docs/user/{faq,install,updating,workers}.md`: links to `libraos/next` and, for LibraOS Core, `libraos/cli`.
- `apps/desktop/resources/linux/com.libraos.next.metainfo.xml`: homepage, bug tracker and source links.
- `apps/web/src/branding.ts`: the desktop download link.
- `apps/web/src/components/settings/MultipleAccountsNote.tsx`, `apps/web/src/legalLinks.ts`: links into `libraos/next`'s docs.
- `packages/contracts/src/t3ProjectFile.ts`: the schema description's documentation link.
- `scripts/build-desktop-artifact.ts`: the package homepage and the `gh release download -R libraos/cli` hint.
- `scripts/build-desktop-artifact.test.ts`: the Linux package carries the `libraos/next` homepage and update feed.
- `apps/desktop/src/updates/DesktopUpdates.test.ts`: the release-page case uses a `libraos/next` feed.
- `apps/web/src/components/desktopUpdate.logic.test.ts`: release links are built for `libraos/next`.

Not changed: patch notes that cite an issue as `libraos/agentd-core#…` or record what an earlier patch left alone.
