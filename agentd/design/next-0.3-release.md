# LibraOS Next 0.3.0: what an AgentD Next 0.2.3 install does with it

0.3.0 is the first release under the new identity: app id `com.libraos.next`, product name
`LibraOS Next`, deb package and executable `libraos-next`, files `LibraOS-Next-*`
(`scripts/build-desktop-artifact.ts:66-67`, `:3006-3010`). AgentD Next 0.2.3 has app id
`ai.libraos.agentd-desktop`, product name `AgentD Next`, deb package and executable `agentd-desktop`
(`git show v0.2.3:scripts/build-desktop-artifact.ts`, lines 66, 2969-2977, 3110, 3139).

Line numbers are of this commit unless a tag is named. electron-updater is the vendored 6.8.9 with our
patch (`node_modules/.pnpm/electron-updater@6.8.9_patch_hash=…/node_modules/electron-updater/out`,
written `EU/` below); NSIS templates are app-builder-lib 26.16.1's (`ABL/templates/nsis`).

## 0.2.3 sees 0.3.0

- 0.2.3's release builds carry a GitHub feed for `libraos/agentd-next`
  (`git show v0.2.3:agentd/scripts/build-desktop.sh` line 119), written into `app-update.yml`.
- The repository was renamed to `libraos/next`. On 2026-11-24 GitHub answers every URL the provider
  requests with a 301 to the new name: `/libraos/agentd-next/releases.atom`,
  `/releases/latest` and `/releases/download/<tag>/latest*.yml`. electron-updater follows redirects.
- With the stable channel the provider asks `/releases/latest` for the tag
  (`EU/providers/GitHubProvider.js:93`, `:228-244`), then fetches that release's `latest.yml`,
  `latest-mac.yml` or `latest-linux.yml` (`:142-161`). The release workflow still uploads all three
  (`.github/workflows/release.yml:173-180`, `:247`), so once 0.3.0 is published as Latest, 0.2.3 is
  offered 0.3.0: `0.3.0 > 0.2.3` (`EU/AppUpdater.js:357`).
- Our updater never downloads or installs on its own: `autoDownload` and `autoInstallOnAppQuit` are off
  (`apps/desktop/src/updates/DesktopUpdates.ts:1361-1362`); the person clicks Download and then Install.
- The update prompt shows the release notes from the feed (`releaseNotes.ts`). It keeps the **last**
  eight lines, shows them last line first, each cut at 220 characters
  (`apps/desktop/src/updates/releaseNotes.ts:21`, `:155-157`). The release notes therefore end with a
  177-character line for AgentD Next installs (`.github/workflows/release.yml:243`); this is the notice
  0.2.3 shows in its own UI on every platform.

Nothing in any updater compares app id, product name or package name: a release on the feed is
installed whatever app it contains.

## Per platform

### macOS: told where to get it

- 0.2.3 release builds are ad-hoc signed (`release.yml:6`), so the packager marks them
  `agentdUpdateInstall: "release-page"` (`scripts/build-desktop-artifact.ts:3016`) and the updater
  opens the release page instead of downloading (`DesktopUpdates.ts:476-490`, `:1485-1488`). The page
  URL is built from `app-update.yml`'s owner and repo (`:492-503`):
  `github.com/libraos/agentd-next/releases/tag/v0.3.0`, which redirects to `libraos/next`.
- Squirrel.Mac never runs, so the bundle id change never reaches it. (A Developer ID signed AgentD Next
  would fail there instead: Squirrel.Mac checks the update against the running app's designated
  requirement, which names the bundle id, and refuses `com.libraos.next`. No such build was released.)
- Result: the prompt shows the notice, Download opens the 0.3.0 page, the person installs
  `LibraOS Next.app` beside `AgentD Next.app`. AgentD Next stays until deleted and keeps showing the
  update when it is opened. Not broken, not looping: it opens a page and only when clicked.

### Windows: moves to LibraOS Next (with this change)

- `NsisUpdater` downloads `LibraOS-Next-0.3.0-x64.exe` from `latest.yml`, checks its sha512, and skips
  the Authenticode check because the unsigned build's `app-update.yml` has no `publisherName`
  (`EU/NsisUpdater.js:84-99`). It runs the installer with `--updated /S --force-run`
  (`EU/NsisUpdater.js:107-113`) and AgentD Next quits.
- The installer's GUID is electron-builder's UUID v5 of the app id (`ABL/../out/targets/nsis/NsisTarget.js:170`):
  `2171255b-f69e-53ce-b5b0-44d690d97019` for `com.libraos.next`, `041eb987-cbe3-5982-b45c-5b3d7642e103`
  for `ai.libraos.agentd-desktop`. Its own old-version uninstall reads only its own GUID's key
  (`ABL/include/installUtil.nsh:155-163`, called from `ABL/installSection.nsh:52`), and the per-user
  folder comes from the package name (`targetUtil.js:41`): `Programs\libraos-next`, not
  `Programs\agentd-desktop`.
- Before this change: LibraOS Next was installed beside AgentD Next and started; AgentD Next stayed with
  its shortcuts and, opened again, offered 0.3.0 again (installing it only reinstalled LibraOS Next).
- Now `customInstall` runs `removePreviousApp` (`apps/desktop/resources/installer.nsh:17-40`, `:70`): when
  `HKCU\…\Uninstall\041eb987-…` names an uninstaller and `HKCU\Software\041eb987-…` an install folder
  other than this one, it copies AgentD Next's own uninstaller out and runs it with
  `/S /KEEP_APP_DATA /currentuser --updated`, as electron-builder does for its own old versions
  (`ABL/include/installUtil.nsh:198-226`). `--updated` keeps app data (`ABL/uninstaller.nsh:216-230`) and
  skips the agentd removal in 0.2.3's `customUnInstall` (`apps/desktop/resources/agentd-uninstall.nsh:5`,
  unchanged since v0.2.3). The uninstaller deletes AgentD Next's files, shortcuts, AppUserModelID and
  registry keys (`ABL/uninstaller.nsh:160-254`), all named apart from LibraOS Next's.
- Installing LibraOS Next by hand does the same. AgentD Desktop (up to 0.1.10-agentd.6) had the same
  app id, so it is removed too. Only per-user installs are looked for: every release was a one-click
  per-user installer.
- Checked on 2026-11-24 in the Windows 11 VM (`next-win`) with the published
  `AgentD-Next-0.2.3-x64.exe` installed: `removePreviousApp`, compiled by app-builder-lib's makensis
  3.0.4.1 into a test installer with `$INSTDIR` set to `Programs\libraos-next`, removed AgentD Next's
  uninstall and install keys, its folder, and its Start menu and desktop shortcuts, both with AgentD Next
  closed and with it running (its uninstaller closed it). `%APPDATA%\agentd-desktop`, `~\.agentd-desktop`
  and `Programs\agentd` with its marker stayed. A second run with nothing installed did nothing. The full
  0.3.0 installer was not built for this; the release build compiles the same macro.

### Linux AppImage: moves to LibraOS Next

- `AppImageUpdater` downloads `LibraOS-Next-x86_64.AppImage` (`EU/AppImageUpdater.js:30-47`). On
  install it deletes `$APPIMAGE` and, since `AgentD-Next-x86_64.AppImage` has no version in its name,
  moves the new file to the same path (`:81-98`), then starts it. A versioned old name gets the new
  file name in the same folder. The file now holds LibraOS Next under the old name; its next updates
  replace it in place again.
- A launcher entry AgentD Next wrote under its old desktop name may stay; it runs the same file.

### Linux deb: moves to LibraOS Next (with this change)

- `DebUpdater` downloads `LibraOS-Next-0.3.0-amd64.deb`, runs `dpkg -i` through pkexec or sudo, then
  `app.relaunch()` (`EU/DebUpdater.js:27-48`, `:56`), which starts `process.execPath`, the old
  `/opt/AgentD Next/agentd-desktop`.
- Before this change: `libraos-next` and `agentd-desktop` share no file, so dpkg installed the new
  package beside the old one; the relaunch started AgentD Next 0.2.3 again, which offered 0.3.0 again:
  an update loop, with a root prompt each time.
- Now the deb declares `Conflicts: agentd-desktop` and `Replaces: agentd-desktop`
  (`scripts/build-desktop-artifact.ts:3181-3185`, test in `build-desktop-artifact.test.ts`). With both,
  dpkg removes the old package when it installs the new one (Debian Policy 7.6.2); `apt install ./…deb`
  does the same. No `Provides`: nothing depends on `agentd-desktop`.
- The relaunch then finds no executable and AgentD Next closes without starting again. The person
  starts LibraOS Next from the applications menu; docs and release notes say so.

## A last AgentD Next release is not needed

Every platform either moves or shows the notice from the 0.3.0 release notes, which 0.2.3 already
renders. Installs at 0.1.10-agentd.8 or earlier do not check for updates at all and are unchanged.

## Misuse cases

What a 0.2.3 updater trusts:

- **Feed.** `github.com/libraos/agentd-next`, reached only through GitHub's rename redirect. Anyone who
  creates a repository named `libraos/agentd-next` (any org member with create rights) ends the
  redirect and becomes the update feed of every 0.2.3 install. Never reuse that name; the same holds for
  `libraos/agentd-desktop` if older installs point there.
- **Signature.** None. Windows checks Authenticode only with a `publisherName` (`EU/NsisUpdater.js:84-99`),
  which unsigned builds lack; Linux checks only the sha512 that the same release's `latest-linux.yml`
  lists; macOS installs nothing itself. Integrity is TLS to GitHub plus who can publish a release on
  `libraos/next`. On deb installs that release runs `dpkg -i` as root after the person approves the
  prompt.
- **App id.** Not checked by any updater. That is why 0.3.0 can replace AgentD Next, and also why any
  release on the feed, of any app, would be installed.
- **Version.** Downgrades are off (`DesktopUpdates.ts:609`); drafts are invisible; the stable channel
  takes only the release marked Latest.

0.2.3 and 0.3.0 running at once on one machine (possible on macOS, and on Windows or Linux after
reinstalling AgentD Next):

- **Electron profile.** Separate folders: LibraOS Next copies AgentD Next's once and never writes the
  old one (`apps/desktop/src/app/libraosUserDataMigration.ts:104-110`). Single-instance locks are per
  profile, so both apps can start.
- **Shared data.** Both use the home `~/.agentd-desktop` (`packages/shared/src/desktopIdentity.ts:33`).
  One server owns a home at a time (`apps/desktop/src/backend/DesktopHomeOwner.ts:38-41`); the app that
  starts second reports the owner instead of starting its backend (`DesktopBackendPool.ts:249-257`).
- **Background service.** Same name, launchd label and Windows task (`desktopIdentity.ts:29-31`). The
  service runs from `<home>/runtime/versions/<version>`, not from either app's folder, so removing
  AgentD Next does not break it, and it only moves forward: a unit at a newer version is left as is
  (`apps/server/src/serviceLauncher.ts:255-271`). 0.2.3 cannot move it back to 0.2.3.
- **Link scheme.** macOS: both bundles declare `agentd-desktop`; Launch Services picks one, while
  `libraos-next` is LibraOS Next's only. Linux: both desktop entries claim `agentd-desktop`; the app
  that ran `xdg-mime` last owns it (`DesktopLinuxUrlHandler.ts`). Windows: neither version registers any
  link scheme: the NSIS config has no protocol entries (`scripts/build-desktop-artifact.ts:3208-3211`)
  and nothing calls `setAsDefaultProtocolClient` (only its wrapper exists, `ElectronApp.ts:202-209`).
  `agentd-desktop://` and `libraos-next://` links do not open either app on Windows today.
- **Terminal command.** LibraOS Next installs `libraos-next` plus `agentd-next` and `t3` as aliases
  (`desktopIdentity.ts:27`); each app refreshes earlier launchers it finds
  (`apps/desktop/src/app/DesktopCliShim.ts:142-183`), so `agentd-next` runs whichever app started last.

## Open

- The whole update path (0.2.3 updating itself to a built 0.3.0 installer) was not run; the parts were:
  electron-updater's NSIS install path above, and the removal macro in the VM.
- Windows link schemes are not registered by either version; a separate change should register both.
