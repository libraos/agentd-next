import { describe, expect, it } from "@effect/vitest";

import {
  hookInput,
  mcpServerEnv,
  mergePlaceholders,
  parsePluginManifest,
  parseHookOutput,
  placeholdersIn,
  pluginEnabled,
  readPluginSettings,
  replacementName,
  hookPrograms,
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

describe("a file a hook replaces with text", () => {
  const FILES = [{ id: "f", name: "lease.docx" }];
  const replace = (attachment: object) =>
    JSON.stringify({ decision: "rewrite", message: { text: "hello", attachments: [attachment] } });

  it.each([
    [{ id: "f", text: "body", name: "lease.docx.txt" }, "lease.docx.txt"],
    [{ id: "f", text: "body" }, "lease.docx.txt"],
    [{ id: "f", text: "body", name: "../../etc/passwd" }, "passwd.txt"],
    [{ id: "f", text: "body", name: "notes.TXT" }, "notes.txt"],
  ])("comes after the shown attachments as text named %j", (attachment, name) => {
    expect(parseHookOutput(replace(attachment), INPUT, {}, FILES)).toEqual({
      _tag: "Rewrite",
      content: {
        text: "hello",
        attachments: [...INPUT.attachments, { id: "f", name, text: "body" }],
      },
      placeholders: {},
    });
  });

  it("is invalid with no text, or when the hook was not offered the file", () => {
    expect(parseHookOutput(replace({ id: "f", text: "" }), INPUT, {}, FILES)).toEqual({
      _tag: "Invalid",
    });
    expect(parseHookOutput(replace({ id: "f", text: "body" }), INPUT, {}, [])).toEqual({
      _tag: "Invalid",
    });
  });

  it("is named after the original when the hook's name is not a file name", () => {
    expect(replacementName("  ", "scan.pdf")).toBe("scan.pdf.txt");
    expect(replacementName("..", "scan.pdf")).toBe("scan.pdf.txt");
    expect(replacementName(`${"x".repeat(300)}.txt`, "a.pdf")).toHaveLength(255);
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

describe("hookPrograms", () => {
  const py = { name: "py", args: ["-3", "hook.py"], skipWindowsApps: false };
  const python = { name: "python", args: ["hook.py"], skipWindowsApps: true };
  it.each([
    [
      "win32",
      "python3",
      [{ name: "python3", args: ["hook.py"], skipWindowsApps: true }, py, python],
    ],
    [
      "win32",
      "Python3",
      [{ name: "Python3", args: ["hook.py"], skipWindowsApps: true }, py, python],
    ],
    ["win32", "node", [{ name: "node", args: ["hook.py"], skipWindowsApps: false }]],
    ["linux", "python3", [{ name: "python3", args: ["hook.py"], skipWindowsApps: false }]],
    ["darwin", "python3", [{ name: "python3", args: ["hook.py"], skipWindowsApps: false }]],
  ] as const)("%s %s", (platform, name, expected) => {
    expect(hookPrograms(platform, name, ["hook.py"])).toEqual(expected);
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

describe("a manifest with MCP servers and settings", () => {
  const valid = {
    schemaVersion: 1,
    id: "outreach",
    name: "Outreach",
    version: "0.1.0",
    settings: [
      { name: "outreach_url", label: "Outreach URL", secret: false, default: "http://localhost" },
      { name: "outreach_token", label: "API key", secret: true },
    ],
    contributes: {
      mcpServers: {
        outreach: {
          command: "outreach",
          args: ["mcp"],
          settings: {
            OUTREACH_URL: "outreach_url",
            OUTREACH_API_KEY_FILE: { setting: "outreach_token", file: true as const },
          },
        },
      },
    },
  };
  const parse = (value: unknown) => parsePluginManifest(JSON.stringify(value));
  const server = valid.contributes.mcpServers.outreach;
  const withServer = (changed: object) => ({
    ...valid,
    contributes: { mcpServers: { outreach: changed } },
  });

  it("parses, with no hooks", () => {
    expect(parse(valid)).toMatchObject({ _tag: "Valid", manifest: valid });
  });

  it.each([
    ["an unknown top-level field", { ...valid, permissions: ["all"] }, "permissions"],
    ["an unknown server field", withServer({ ...server, cwd: "/" }), "cwd"],
    ["a server without a command", withServer({ args: ["mcp"] }), "command"],
    ["a server outside the plugin", withServer({ ...server, command: "../x" }), "not safe"],
    [
      "a secret setting with a default",
      { ...valid, settings: [valid.settings[0], { ...valid.settings[1], default: "k" }] },
      "secret and cannot have a default",
    ],
    [
      "a secret setting given as a plain env value",
      withServer({ ...server, settings: { OUTREACH_API_KEY: "outreach_token" } }),
      "given as a file",
    ],
    [
      "a setting that is not declared",
      withServer({ ...server, settings: { OUTREACH_URL: "nope" } }),
      "not a declared setting",
    ],
    [
      "a server name with a dot",
      { ...valid, contributes: { mcpServers: { "out.reach": server } } },
      "out.reach",
    ],
  ])("refuses %s", (_label, manifest, reason) => {
    const parsed = parse(manifest);
    expect(parsed._tag).toBe("Invalid");
    expect(parsed._tag === "Invalid" && parsed.reasons.join("\n")).toContain(reason);
  });

  it("gives a server its settings as env, a file setting as its path, or leaves it out", () => {
    const value = (setting: { readonly name: string }) =>
      setting.name === "outreach_token" ? "secret" : undefined;
    const file = (setting: string) => `/state/${setting}`;
    expect(mcpServerEnv(server, valid.settings, value, file)).toEqual({
      _tag: "Ready",
      env: { OUTREACH_URL: "http://localhost", OUTREACH_API_KEY_FILE: "/state/outreach_token" },
    });
    expect(mcpServerEnv(server, valid.settings, () => undefined, file)).toEqual({
      _tag: "Missing",
      settings: ["outreach_token"],
    });
  });
});
