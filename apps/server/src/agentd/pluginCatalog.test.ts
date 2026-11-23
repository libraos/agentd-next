import { describe, expect, it } from "@effect/vitest";

import {
  hookInput,
  mergePlaceholders,
  parseHookOutput,
  placeholdersIn,
  pluginEnabled,
  readPluginSettings,
  resolveHookCommand,
  withoutPlugin,
  withPluginEnabled,
} from "./pluginCatalog.ts";

const INPUT = { text: "hello", attachments: [{ id: "a", name: "a.txt", text: "one" }] };

describe("parseHookOutput", () => {
  it.each([
    ['{"decision":"pass"}', { _tag: "Pass" }],
    ['{"decision":"block","reason":"  no  "}', { _tag: "Block", reason: "no" }],
    [
      '{"decision":"rewrite","message":{"text":"hello","attachments":[{"id":"a","text":"one"}]}}',
      { _tag: "Pass" },
    ],
    [
      '{"decision":"rewrite","message":{"text":"hi","attachments":[{"id":"a","text":"two"}]}}',
      {
        _tag: "Rewrite",
        content: { text: "hi", attachments: [{ id: "a", name: "a.txt", text: "two" }] },
        placeholders: {},
      },
    ],
    [
      '{"decision":"rewrite","message":{"text":"hi"}}',
      { _tag: "Rewrite", content: { ...INPUT, text: "hi" }, placeholders: {} },
    ],
    [
      '{"decision":"rewrite","message":{"text":"hi","attachments":[{"id":"b","text":"x"}]}}',
      { _tag: "Invalid" },
    ],
    [
      '{"decision":"rewrite","message":{"text":"hi","attachments":[{"id":"a","text":"x"},{"id":"a","text":"y"}]}}',
      { _tag: "Invalid" },
    ],
    ['{"decision":"allow"}', { _tag: "Invalid" }],
    ['{"decision":"pass"}\n{"decision":"block","reason":"x"}', { _tag: "Invalid" }],
    ["", { _tag: "Invalid" }],
  ])("%s", (stdout, expected) => {
    expect(parseHookOutput(stdout, INPUT)).toEqual(expected);
  });
});

describe("the thread's placeholder map", () => {
  const MAP = { "[PERSON_1]": "Maren Holloway" };
  const rewrite = (placeholders?: object) =>
    JSON.stringify({
      decision: "rewrite",
      message: { text: "[PERSON_2] and [PERSON_1]" },
      placeholders,
    });

  it("goes to the hook, and a rewrite adds to it", () => {
    expect(
      JSON.parse(
        hookInput({
          content: INPUT,
          unshown: [],
          projectId: "p",
          threadId: "t",
          source: "web",
          placeholders: MAP,
        }),
      ).placeholders,
    ).toEqual(MAP);
    expect(
      parseHookOutput(rewrite({ ...MAP, "[PERSON_2]": "Jonas Brekke" }), INPUT, MAP),
    ).toMatchObject({
      placeholders: { "[PERSON_1]": "Maren Holloway", "[PERSON_2]": "Jonas Brekke" },
    });
  });

  it("stays as it was for a hook that returns none or only part of it", () => {
    expect(parseHookOutput(rewrite(), INPUT, MAP)).toMatchObject({ placeholders: MAP });
    expect(parseHookOutput(rewrite({ "[PERSON_2]": "J" }), INPUT, MAP)).toMatchObject({
      placeholders: { ...MAP, "[PERSON_2]": "J" },
    });
  });

  it.each([
    ["a known placeholder given another value", { "[PERSON_1]": "Someone Else" }],
    ["a placeholder that is a word", { PERSON_2: "x" }],
    ["an empty value", { "[PERSON_2]": "" }],
  ])("makes the answer invalid for %s", (_case, placeholders) => {
    expect(parseHookOutput(rewrite(placeholders), INPUT, MAP)).toEqual({ _tag: "Invalid" });
    expect(mergePlaceholders(MAP, placeholders)).toBeNull();
  });

  it("lists the placeholders a message uses in order", () => {
    const map = { "[A_1]": "a", "[B_1]": "b", "[C_1]": "c" };
    const content = {
      text: "see [B_1] then [A_1]",
      attachments: [{ id: "x", name: "x", text: "[C_1] [A_1]" }],
    };
    expect(placeholdersIn(content, map)).toEqual(["[B_1]", "[A_1]", "[C_1]"]);
  });
});

describe("resolveHookCommand", () => {
  it.each([
    [["./hook.sh", "x"], { _tag: "File", path: "/p/hook.sh", args: ["x"] }],
    [["bin/hook"], { _tag: "File", path: "/p/bin/hook", args: [] }],
    [["../escape"], { _tag: "Unsafe" }],
    [["/usr/bin/env"], { _tag: "Unsafe" }],
    [["node", "hook.js"], { _tag: "Path", name: "node", args: ["hook.js"] }],
    [["-rf"], { _tag: "Unsafe" }],
  ])("%j", (argv, expected) => {
    expect(resolveHookCommand("linux", "/p", argv)).toEqual(expected);
  });
});

describe("plugin settings", () => {
  it("a project's override wins and clearing it falls back to the environment", () => {
    const on = withPluginEnabled(readPluginSettings("not json"), "x", true);
    expect(pluginEnabled(on, "x")).toBe(true);
    const off = withPluginEnabled(on, "x", false, "p");
    expect(pluginEnabled(off, "x", "p")).toBe(false);
    expect(pluginEnabled(off, "x", "q")).toBe(true);
    expect(pluginEnabled(withPluginEnabled(off, "x", null, "p"), "x", "p")).toBe(true);
    expect(withoutPlugin(withPluginEnabled(off, "y", true, "p"), "x")).toEqual({
      enabled: {},
      projects: { p: { y: true } },
    });
  });
});
