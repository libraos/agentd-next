# 58: Set up agentd when the app opens: the EULA, then `agentd init`

When the environment's agentd is not set up (`agentd doctor --json` says `set_up: false`, its activation check says the EULA is not accepted, or the accepted EULA's number differs from the one `agentd eula` carries), the app opens a **Set up AgentD** dialog: the agreement's full text from `agentd eula` (scrollable), its version, the link https://libraos.com/eula, **Accept and set up** and **Not now**. Accept makes the server run `agentd init --route on` in that environment's home folder (so init registers no repository), in a pseudo-terminal from the server's terminal layer (`PtyAdapter`, node-pty). The server types `yes` once, only at `Type yes to accept:`, and only in a run the click started; any other prompt (an unfinished line ending in `:`, `?`, `]`, `)` or `>` that stays 2 s, or a second EULA prompt) stops init. Init's output streams into the dialog; exit 0 refreshes the status and closes it; anything else shows what agentd said, why the app stopped it if it did, and **Try again**. A run is limited to 10 minutes. When `agentd init --help` names `--accept-eula` (read once per agentd version), the flag is passed too.

New, ours:

- `apps/server/src/agentd/agentdInit.ts`: the `AgentdInit` service (start, subscribe): one init run at a time per environment, kept on the server so it goes on if the client disconnects and every client sees it.
- `apps/server/src/agentd/agentdInit.test.ts`: which unfinished lines are prompts, escape-sequence removal, and when the status counts as set up (hand-written rows).
- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: the dialog, its host and `openAgentdSetupDialog`. It opens by itself for the primary environment when it is not set up and the connection may set it up (`AuthEnvironmentMaintainScope`), until Not now for this app run; the AgentD page opens it at any time.

Upstream files changed (fewest lines):

- `apps/web/src/routes/__root.tsx`: one import and one `<AgentdSetupDialogHost />` among the app's dialog hosts, which render before and over the first-run screens.
- `apps/server/src/server.ts`: `AgentdInit.layer` merged into the agentd layer, given the existing `PtyAdapter` layer.
- `apps/server/src/ws.ts`: three handlers (`agentd.eula`, `agentd.setupStart`, `agentd.subscribeSetup`), each one service call.
- `apps/server/src/ws.test.ts`: the new service mocked beside the other agentd services.
- `apps/server/src/auth/RpcAuthorization.ts`: read scope for `agentd.eula` and `agentd.subscribeSetup`.
- `apps/server/src/observability/RpcInstrumentation.ts`: the three methods under `agentd`.
- `packages/contracts/src/clientRpcPermissions.ts`: `agentd.setupStart` needs `AuthEnvironmentMaintainScope` (it accepts the EULA and writes services on the host).
- `packages/contracts/src/rpc.ts`: the three methods and their RPCs, at the end of the agentd lists.
- `packages/client-runtime/src/rpc/client.ts`: `agentd.subscribeSetup` among the subscription tags.

Shared files (entries added at the end, fewest lines):

- `packages/contracts/src/agentd.ts`: `AgentdEula`, `AgentdSetupState`.
- `apps/server/src/agentd/agentdCommands.ts`: `eula`, `initHelp`, `init`.
- `apps/server/src/agentd/AgentdBridge.ts`: `eula`; `status` reads `agentd eula` only when doctor names an accepted version, to compare it.
- `apps/server/src/agentd/agentdJson.ts`: `acceptedEula`, `eulaVersion`; `agentdStatus` folds the EULA into `setUp`.
- `packages/client-runtime/src/state/agentd.ts`: `eula`, `setup`, `setupStart` atoms.
- `apps/web/src/lib/agentdState.ts`: `useAgentdEula`, `useAgentdSetup`.
- `apps/web/src/components/agentd/AgentdPage.tsx`, `AgentdPageReads.tsx`: the not-set-up message gets a **Set up AgentD** button.

#55: its install pass (`installAgentdAfterConsent`) runs when Accept is clicked in the desktop app, before init (#77), as well as at first-run completion and at launch.

Summary: agentd v0.1.13 has no command that prints the agreement's short summary alone; `agentd init` prints it just before its prompt, so it shows in the dialog's output once init runs. The dialog itself shows the full text.

Windows: the binary comes from the existing resolver (`.exe`), init runs through node-pty (ConPTY) with the home folder from `HostProcess.HomeDirectory`, `yes` is sent with `\r`, and console escape sequences are removed. Not verified on Windows: the run itself, ConPTY echo of the answer, and an agentd found only as a `.cmd` shim (node-pty starts executables, not `.cmd` files). Linux: run against agentd v0.1.13 with scratch `HOME` and `AGENTD_ROOT`: the EULA was accepted by the typed `yes`, the services step failed without a user bus and init exited 1 with its message shown; a fake agentd asking `Activation code:` after the EULA was stopped.
