import { describe, expect, it } from "@effect/vitest";

import {
  claudeAttachCommand,
  initTakesPermissionMode,
  permissionModeState,
} from "./permissionMode.ts";

describe("permissionModeState", () => {
  it.each([
    ['"guarded"', "{}", "{}", { mode: "guarded", scopedYolo: false }],
    ['"yolo"', "{}", "{}", { mode: "yolo", scopedYolo: false }],
    ['"guarded"', '{"reviewer":"yolo"}', "{}", { mode: "guarded", scopedYolo: true }],
    ['"guarded"', "{}", '{"/src/app":"yolo"}', { mode: "guarded", scopedYolo: true }],
    ['"guarded"', '{"reviewer":"guarded"}', null, { mode: "guarded", scopedYolo: false }],
    ["guarded\n", null, null, { mode: "guarded", scopedYolo: false }],
    // An agentd from before the setting: it is not exposed, so nothing is read.
    [null, null, null, { mode: null, scopedYolo: false }],
    ['"something"', null, null, { mode: null, scopedYolo: false }],
  ] as const)("global %j, roles %j, repos %j", (global, roles, repos, expected) => {
    expect(permissionModeState(global, roles, repos)).toEqual(expected);
  });
});

describe("initTakesPermissionMode", () => {
  it("reads the flag from init's help", () => {
    expect(
      initTakesPermissionMode(
        "  -permission-mode string\n    \tguarded or yolo: the worker permission mode",
      ),
    ).toBe(true);
    expect(initTakesPermissionMode("  -route string\n  -accept-eula")).toBe(false);
  });
});

describe("claudeAttachCommand", () => {
  it.each([
    ["backgrounded · abcdef1234 · claude attach abcdef1234\n", "claude attach abcdef1234"],
    ["agentd worker started\n", "claude attach"],
  ])("%j", (head, command) => {
    expect(claudeAttachCommand(head)).toBe(command);
  });
});
