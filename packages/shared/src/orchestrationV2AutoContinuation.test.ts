import { describe, expect, it } from "@effect/vitest";

import {
  type AutoContinuationInput,
  autoContinuationStopMessage,
  decideAutoContinuation,
  parseCompletionStatus,
} from "./orchestrationV2AutoContinuation.ts";

const base: AutoContinuationInput = {
  enabled: true,
  maxContinuations: 3,
  runStatus: "completed",
  finalMessage: "Wired the reader.\n\nStatus: remaining: run chapter 1 end to end",
  userStopped: false,
  awaitingUser: false,
  usageLimited: false,
  continuationsSoFar: 0,
  madeProgress: true,
};

describe("parseCompletionStatus", () => {
  it.each([
    ["All tests pass.\nStatus: done", { type: "done" }],
    ["x\nStatus: remaining: wire the reader\n\n", { type: "remaining", detail: "wire the reader" }],
    ["x\n**Status:** remaining — wire it", { type: "remaining", detail: "wire it" }],
    ["x\nstatus: BLOCKED: needs an API key", { type: "blocked", detail: "needs an API key" }],
    ["x\nStatus: remaining", { type: "remaining", detail: "" }],
  ])("reads %j", (text, expected) => {
    expect(parseCompletionStatus(text)).toEqual(expected);
  });

  it.each([
    ["no marker at all", "Chapter 1 still has not run end-to-end."],
    ["marker not on the last line", "Status: remaining: quoted from a file\nMore prose after it."],
    ["marker inside a sentence", "The file says Status: remaining: x"],
    ["unknown status word", "Status: partially"],
    ["empty message", "   \n"],
  ])("ignores %s", (_case, text) => {
    expect(parseCompletionStatus(text)).toBeUndefined();
  });
});

describe("decideAutoContinuation", () => {
  it("continues a completed turn whose final message says work remains", () => {
    expect(decideAutoContinuation(base)).toEqual({
      type: "continue",
      remaining: "run chapter 1 end to end",
      continuation: 1,
    });
  });

  it("keeps today's behaviour without a marker, with done, or when turned off", () => {
    expect(decideAutoContinuation({ ...base, finalMessage: "Chapter 1 still fails." })).toEqual({
      type: "none",
    });
    expect(decideAutoContinuation({ ...base, finalMessage: "ok\nStatus: done" })).toEqual({
      type: "none",
    });
    expect(decideAutoContinuation({ ...base, finalMessage: undefined })).toEqual({ type: "none" });
    expect(decideAutoContinuation({ ...base, enabled: false })).toEqual({ type: "none" });
  });

  it.each([
    ["the user pressed stop", { userStopped: true }, "stopped"],
    ["the run was interrupted", { runStatus: "interrupted" }, "stopped"],
    ["the turn waits for an approval or question", { awaitingUser: true }, "awaiting_user"],
    ["the run waits", { runStatus: "waiting" }, "awaiting_user"],
    ["the run failed", { runStatus: "failed" }, "failed"],
    ["a usage limit was reached", { usageLimited: true, runStatus: "failed" }, "usage_limit"],
    ["the agent says blocked", { finalMessage: "x\nStatus: blocked: need a token" }, "blocked"],
    [
      "a continuation made no progress",
      { continuationsSoFar: 1, madeProgress: false },
      "no_progress",
    ],
    ["the cap is reached", { continuationsSoFar: 3 }, "limit_reached"],
    ["the cap is zero", { maxContinuations: 0 }, "limit_reached"],
  ] as const)("stops and says why when %s", (_case, patch, reason) => {
    const decision = decideAutoContinuation({ ...base, ...patch });
    expect(decision.type).toBe("stop");
    expect(decision.type === "stop" && decision.reason).toBe(reason);
  });

  it("ends an agent that says remaining forever at the cap", () => {
    const decisions = [0, 1, 2, 3].map(
      (continuationsSoFar) => decideAutoContinuation({ ...base, continuationsSoFar }).type,
    );
    expect(decisions).toEqual(["continue", "continue", "continue", "stop"]);
  });

  it("does not count the user's own turn as a no-progress continuation", () => {
    expect(decideAutoContinuation({ ...base, madeProgress: false }).type).toBe("continue");
  });

  it("names what remains in the stop message", () => {
    expect(autoContinuationStopMessage("limit_reached", "wire the reader")).toContain(
      "What remains: wire the reader",
    );
  });
});
