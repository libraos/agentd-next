import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { installAgentdAfterConsent } from "../../backend/agentdInstall.ts";
import * as DesktopShellEnvironment from "../../shell/DesktopShellEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/** Set up LibraOS Engine's Accept: the person consented, so the bundled agentd goes in before init. */
export const installAgentd = makeIpcMethod({
  channel: IpcChannels.AGENTD_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.agentd.install")(function* () {
    // The login shell's PATH decides where the install pass finds claude, codex and opencode.
    yield* (yield* DesktopShellEnvironment.DesktopShellEnvironment).awaitUserShellDiscovery;
    yield* installAgentdAfterConsent();
  }),
});
