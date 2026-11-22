// @effect-diagnostics nodeBuiltinImport:off - runs the plugin's Python hook as the host would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { decodePluginManifest, hookInput, parseHookOutput } from "./pluginCatalog.ts";

// The redaction plugin (agentd/plugins/redact) against the host's own stdin format and parser.
// fake_hook.py replaces veil-detect with a detector that tags one made-up name.
const PLUGIN = NodePath.join(import.meta.dirname, "../../../../agentd/plugins/redact");
const NAME = "Maren Holloway";
const EMAIL = "maren.holloway@example.org";
const API_KEY = "sk-ant-api03-Zq7XvB2mN9pL4kR8tY1wE6uI3oA5sD0f";
const content = {
  text: `Lease for ${NAME}, reach her at ${EMAIL}, key ${API_KEY}.`,
  attachments: [{ id: "att-1", name: "notes.txt", text: `Client: ${NAME}\nkey=${API_KEY}\n` }],
};

function run(
  script: string,
  args: ReadonlyArray<string>,
  unshown: ReadonlyArray<{ id: string; name: string }> = [],
) {
  const data = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "redact-plugin-"));
  try {
    const result = NodeChildProcess.spawnSync("python3", [script, ...args], {
      cwd: PLUGIN,
      input: hookInput({ content, unshown, projectId: "p", threadId: "t", source: "web" }),
      env: { ...process.env, AGENTD_REDACT_DATA_DIR: data },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return parseHookOutput(result.stdout, content);
  } finally {
    NodeFS.rmSync(data, { recursive: true, force: true });
  }
}

describe("redaction plugin hook", () => {
  it("declares a before-send hook the host can run", () => {
    const manifest = decodePluginManifest(
      NodeFS.readFileSync(NodePath.join(PLUGIN, "agentd-plugin.json"), "utf8"),
    );
    expect(manifest._tag === "Some" && manifest.value.hooks["before-send"]).toEqual({
      command: ["python3", "hook.py"],
      timeoutSeconds: 60,
    });
  });

  it("rewrites the name, email and key out of the text and the attachment", () => {
    const decision = run("tests/fake_hook.py", []);
    expect(decision._tag).toBe("Rewrite");
    const sent = JSON.stringify(decision._tag === "Rewrite" ? decision.content : null);
    for (const secret of [NAME, EMAIL, API_KEY]) expect(sent).not.toContain(secret);
  });

  it.each([
    ["an attachment it cannot read", "tests/fake_hook.py", [], [{ id: "x", name: "scan.png" }]],
    ["a detector that throws", "tests/fake_hook.py", ["raise"], []],
    ["no Python environment yet", "hook.py", [], []],
  ] as const)("blocks with a reason for %s", (_case, script, args, unshown) => {
    const decision = run(script, args, unshown);
    expect(decision._tag).toBe("Block");
    expect(decision._tag === "Block" && decision.reason.length).toBeGreaterThan(20);
  });
});
