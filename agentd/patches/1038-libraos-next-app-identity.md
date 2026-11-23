# LibraOS Next app identity (libraos/agentd-core#1038)

The desktop app becomes LibraOS Next: app id `com.libraos.next`, product name `LibraOS Next`, files `LibraOS-Next-*`, deb package and executable `libraos-next`, links `libraos-next://`, and profile folder `libraos-next`. On first start, if only AgentD Next's `agentd-desktop` folder exists, it is copied into the new folder. The copy skips links, special files, the profile lock and caches, is staged in a private folder and renamed into place, and never changes the old folder. The app bundles LibraOS Core as `libraos-core` when the Core release publishes that asset, otherwise as `agentd`, and looks for either name.

Kept for compatibility:

- **Renderer origin `agentd-desktop://app`.** Local Storage, the Clerk sign-in and the CORS allowance of servers already deployed are keyed to it. Only the links the app builds and registers change name.
- **Electron app name `AgentD Next`.** safeStorage keys secrets by the app name (macOS Keychain, Linux keyring); a new name would leave saved sign-in tokens undecryptable.
- **Other names.** The LaunchAgent label and other service names, the `.agentd-desktop` home, the KDE capture `.desktop` file (renaming it would leave the old one behind), the terminal command and its link (another change owns them), and the repository URLs.

Upstream files changed:

- `scripts/build-desktop-artifact.ts`: appId, productName, artifact and AppImage names, `extraMetadata.name`, linux `executableName`, deb `packageName` and doc path, macOS usage strings, and link schemes (new plus legacy). The Core binary is staged as `libraos-core` when its release publishes it.
- `scripts/build-desktop-artifact.test.ts`: the identity, AppImage, passkey appId and Core staging expectations.
- `apps/desktop/package.json`: `productName`.
- `apps/desktop/scripts/electron-launcher.mjs`: dev bundle name and id, both link schemes, usage strings.
- `apps/desktop/resources/installer.nsh`: the running-app check also names AgentD Next.
- `apps/desktop/resources/linux/com.libraos.next.metainfo.xml` (renamed from `ai.libraos.agentd-desktop.metainfo.xml`): new id, name, launchable and binary, plus `<replaces>` for the old id.
- `apps/desktop/gnome-extension/{captureService,captureFeedback}.js`, `metadata.json`: new D-Bus client names, with AgentD Next's still served; product name; version 4.
- `apps/desktop/gnome-extension/captureService.test.js`, `src/snapShot/GnomeCaptureSetup.test.ts`: new names and extension version.
- `apps/desktop/src/app/DesktopEnvironment.ts`: display name, `ELECTRON_APP_NAME_BASE`, AppUserModelID.
- `apps/desktop/src/app/DesktopAppIdentity.ts`: `setName` uses `ELECTRON_APP_NAME_BASE`.
- `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`: Linux desktop entry name.
- `apps/desktop/src/app/DesktopUserData.ts`: profile folder name from `libraosUserDataMigration.ts`.
- `apps/desktop/src/app/DesktopClerk.ts`: the one-time profile copy runs before the profile path is set.
- `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`, `DesktopPreReadyPlatform.ts`: register both link schemes.
- `apps/desktop/src/app/DesktopLifecycle.ts`: a relaunch drops links of either scheme from argv.
- `apps/desktop/src/electron/ElectronProtocol.ts`: the renderer scheme stays `agentd-desktop`.
- Tests beside the above: `DesktopAppIdentity`, `DesktopClerk` (old and new links open the app), `DesktopEnvironment`, `DesktopLifecycle`, `DesktopLinuxUrlHandler`, `DesktopPreReadyPlatform`, `DesktopUserData`.
- `packages/shared/src/codexAuthHandoff.ts`: accepts the hand-off link under either scheme.
- `packages/shared/src/providerAuthReturnUrl.ts`: the desktop return origin is the renderer's (legacy) scheme.
- `packages/shared/src/remote.ts`: comments. Tests: `codexAuthHandoff`, `promptLinks`, `remote`.
- `.github/workflows/release.yml`: `LibraOS-Next-*` files, release title and notes, including a note for people coming from AgentD Next.
- `README.md`, `docs/user/install.md`: file names, and the new app is installed beside the old one.

Ours, not upstream's: `packages/shared/src/desktopIdentity.ts` (link scheme constants and `appLinkSchemes`), `apps/desktop/src/app/libraosUserDataMigration.ts` and its test, `apps/desktop/src/backend/agentdBinary.ts` (looks for `libraos-core` first, then `agentd`, and reads either one's version) and its test, and `agentd/scripts/build-desktop.sh` (file names, and downloads the `libraos-core-*` asset).

Messages, logs and labels outside the `msg()` catalogs that name the app (product name only; identifiers, the old profile folder and the `agentd-desktop://` scheme are unchanged):

- `apps/desktop/src/app/{DesktopAppActivation,DesktopAppActivationBroker,DesktopStartupRecovery}.ts`: activation errors and the copied failure report.
- `apps/desktop/src/app/DesktopCliCommand.ts`, `DesktopCliShim.ts`: PATH messages, the shell-startup comment and the moved-app message (the shim marker stays for the CLI change).
- `apps/desktop/src/ssh/{DesktopSshEnvironment,DesktopSshPasswordPrompts}.ts`: window-unavailable errors.
- `apps/desktop/src/updates/{DesktopUpdates,DesktopUpdatePolicy}.ts`: managed-policy messages.
- `apps/desktop/src/snapShot/{DesktopSnapShot,GnomeCaptureSetup,HyprlandSnapShot,KdeSnapShot,LinuxSnapShot,NiriCaptureShortcut,NiriSnapShot,PortalCaptureShortcut,SnapShotTransition}.ts`: capture setup and permission messages, the KDE helper's display name, the animation window title.
- `apps/desktop/src/wsl/DesktopWslEnvironment.ts`, `src/electron/WindowsForeground.ts`: error messages.
- `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`: the desktop session's label.
- `apps/desktop/src/preview/BrowserSession.ts`, `src/app/DesktopLegacyLocalStorage.ts`: comments.
- `apps/desktop/resources/dmg/dmg-background-{latest,nightly}.svg`: "Drag LibraOS Next into Applications."
- Tests: `DesktopSnapShot`, `DesktopCliCommand`, `DesktopUpdates`.
