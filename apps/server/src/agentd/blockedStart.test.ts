import { describe, expect, it } from "@effect/vitest";

import { blockingRefusal } from "./blockedStart.ts";

describe("blockingRefusal", () => {
  it.each([
    [
      "error: dispatch refused: /work/app already has handoff hof-0a1b2c3d4e, claimed by session codex-615065aa16; wait for it, use another worktree or issue, or override with --force",
      { id: "hof-0a1b2c3d4e", state: "claimed", running: false },
    ],
    [
      "error: dispatch refused: C:\\work\\app already has a running claude worker on handoff hof-99aa88bb77 (claimed, session claude-1234abcd); wait for it, use another worktree or issue, or override with --force",
      { id: "hof-99aa88bb77", state: "claimed", running: true },
    ],
    [
      "error: dispatch refused: issue owner/app#12 already has open handoff hof-5566778899 (offered); wait for it, use another worktree or issue, or override with --force",
      { id: "hof-5566778899", state: "offered", running: false },
    ],
  ])("names the task in %s", (message, expected) => {
    expect(blockingRefusal(message)).toEqual(expected);
  });

  it("leaves other refusals to their own text", () => {
    expect(
      blockingRefusal(
        "error: dispatch refused: handoff hof-0a1b2c3d4e already has a claude worker starting",
      ),
    ).toBeNull();
    expect(blockingRefusal("error: budget 5m is below the worker's minimum")).toBeNull();
  });
});
