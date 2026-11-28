import {
  isLibraosGatewayInstanceId,
  type LibraosGatewaySignIn,
  type LibraosGatewayStatus,
  type ServerProvider,
} from "@t3tools/contracts";

/** A key the Gateway refuses cannot pay for a worker, though it is still stored. */
export function isLibraosGatewayUsable(
  status: Pick<LibraosGatewayStatus, "connected" | "refusal"> | null | undefined,
): boolean {
  return status?.connected === true && !status.refusal;
}

/**
 * Changes when the Gateway agents are probed again. A provider refresh re-reads the key first, so
 * the Gateway's status is stale from then on.
 */
export function libraosGatewayAgentsChecked(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "checkedAt">> | null,
): string {
  return (providers ?? [])
    .filter((provider) => isLibraosGatewayInstanceId(provider.instanceId))
    .map((provider) => `${provider.instanceId}@${provider.checkedAt}`)
    .toSorted()
    .join(",");
}

/**
 * One click on Sign in, as this client follows it; the server's pending sign-in is the rest.
 * `ended` is the code of a sign-in this client saw end, which a stale status may still list.
 */
export type LibraosSignInAttempt =
  | { readonly phase: "idle"; readonly ended: string | null }
  | { readonly phase: "starting"; readonly id: number }
  | {
      readonly phase: "waiting";
      readonly id: number;
      readonly signIn: LibraosGatewaySignIn;
      /** The browser was opened for it from this window. */
      readonly opened: boolean;
    }
  | {
      readonly phase: "failed";
      readonly id: number;
      readonly error: string;
      readonly hadCode: boolean;
    }
  /** Approved; the view hands back to the page that showed it. */
  | { readonly phase: "done"; readonly id: number; readonly ended: string | null }
  /** Handed back: the page moves focus to its next step. */
  | { readonly phase: "signedIn"; readonly ended: string | null };

export type LibraosSignInView =
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly signIn: LibraosGatewaySignIn; readonly opened: boolean }
  | { readonly kind: "failed"; readonly error: string; readonly hadCode: boolean }
  | { readonly kind: "done" };

/**
 * What the sign-in view shows, or null for the page itself. A connect sign-in the server is running
 * (started before a reload or on another client) is shown too; a revoke is the Gateway panel's.
 */
export function libraosSignInView(
  attempt: LibraosSignInAttempt,
  pending: LibraosGatewaySignIn | null,
): LibraosSignInView | null {
  switch (attempt.phase) {
    case "starting":
      return { kind: "starting" };
    case "waiting":
      return { kind: "waiting", signIn: attempt.signIn, opened: attempt.opened };
    case "failed":
      return { kind: "failed", error: attempt.error, hadCode: attempt.hadCode };
    case "done":
      return { kind: "done" };
    case "idle":
    case "signedIn":
      return pending?.purpose === "connect" && pending.userCode !== attempt.ended
        ? { kind: "waiting", signIn: pending, opened: false }
        : null;
  }
}
