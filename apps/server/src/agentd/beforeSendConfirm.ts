import * as Effect from "effect/Effect";

import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import type { BeforeSendResend } from "./AgentdPlugins.ts";
import { checked } from "./beforeSendGate.ts";

/** Sends a confirmed message through the intake; its hooks already ran, so they do not run again. */
export const sendConfirmed = Effect.fn("beforeSendConfirm.sendConfirmed")(function* (
  resend: BeforeSendResend,
  sender: { readonly managesProviders: boolean },
) {
  if (resend.kind === "launch") {
    yield* checked(ThreadMessageIntake.launchThread(resend.input));
    return;
  }
  yield* checked(ThreadMessageIntake.dispatchCommand(resend.command, sender));
});
