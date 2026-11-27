import type { Wakeups } from "@t3tools/client-runtime/connection";

const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

/**
 * Turns app state changes into the wakeup each return to the foreground sends. Only a return from
 * the background probes the live connection: an iOS app that was only inactive (a system alert
 * such as "Open in …?", Control Center, a Face ID prompt) keeps its socket, and a quick probe of a
 * busy host would replace a healthy one.
 */
export function createAppStateWakeups(startState: string | null | undefined, startedAtMs: number) {
  let backgroundedAtMs = startState === "background" ? startedAtMs : null;
  return (state: string, nowMs: number): MobileApplicationActiveWakeup | null => {
    if (state === "background") {
      backgroundedAtMs = nowMs;
      return null;
    }
    if (state !== "active" || backgroundedAtMs === null) return null;
    const wakeup =
      nowMs - backgroundedAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
        ? "application-active-long"
        : "application-active-probe";
    backgroundedAtMs = null;
    return wakeup;
  };
}
