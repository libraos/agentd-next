# #77: Accept in Set up LibraOS Engine installs the bundled agentd before init

LibraOS Engine reaches chats through its global setup (`agentd init` connects Claude, Codex and opencode), so the binary init runs and registers should already be at its install location. Before, the install pass (#55) waited for first-run completion (`onboardingCompletedAt`), which the Set up dialog (#58) comes before. Now **Accept and set up** in the desktop app runs that pass first, waits for it, then starts init. The launch and first-run triggers stay. **Not now** installs nothing. On the web (no desktop bridge), for another environment, or for a WSL backend (init runs inside WSL, the bundle is a Windows binary), Accept does what it did before. A failed or missing install (an older desktop build) does not stop init.

New, ours:

- `apps/web/src/components/agentd/agentdSetupInstall.logic.ts`: `installAgentdBeforeSetup`, called only for the primary environment when the desktop app runs it natively.
- `apps/web/src/components/agentd/agentdSetupInstall.logic.test.ts`: which environments install, that init waits for the install, and that a failure or a missing bridge method goes on.
- `apps/desktop/src/ipc/methods/agentdInstall.ts`: the `installAgentd` IPC method; waits for the login-shell PATH as the launch trigger does, then runs `installAgentdAfterConsent`.

Changed, ours:

- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: Accept awaits `installAgentdBeforeSetup` before `agentd.setupStart` (the dialog already shows Setting up… meanwhile).
- `apps/desktop/src/backend/agentdInstall.ts`: passes run one at a time (launch, first run and Accept can overlap and share the `agentd.new.<pid>` temp name).

Upstream files changed (fewest lines):

- `apps/desktop/src/ipc/channels.ts`: `AGENTD_INSTALL_CHANNEL`.
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts`: one import and one `ipc.handle(installAgentd)`.
- `apps/desktop/src/preload.ts`: `installAgentd` on the bridge.
- `packages/contracts/src/ipc.ts`: optional `installAgentd` on `DesktopBridge` (optional so an older desktop build's bridge still types).

Windows: the pass is the same one #55 runs (paths from `USERPROFILE`/`LOCALAPPDATA`, PATH through PowerShell); this change only calls it earlier. Not run on Windows or in a packaged build here: the IPC call needs the bundle, which dev builds lack, so there the pass returns at once and init runs as before.
