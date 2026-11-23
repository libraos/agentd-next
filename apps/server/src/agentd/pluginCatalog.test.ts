import { describe, expect, it } from "@effect/vitest";

import {
  parseHookOutput,
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
      },
    ],
    [
      '{"decision":"rewrite","message":{"text":"hi"}}',
      { _tag: "Rewrite", content: { ...INPUT, text: "hi" } },
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
