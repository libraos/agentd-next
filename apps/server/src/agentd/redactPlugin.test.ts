// @effect-diagnostics nodeBuiltinImport:off - runs the plugin's Python hook as the host would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import {
  type HookUnshownAttachment,
  decodePluginManifest,
  hookInput,
  parseHookOutput,
} from "./pluginCatalog.ts";

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
  unshown: ReadonlyArray<HookUnshownAttachment> = [],
  message = content,
  placeholders: Record<string, string> = {},
  python = "python3",
) {
  const data = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "redact-plugin-"));
  try {
    const result = NodeChildProcess.spawnSync(python, [script, ...args], {
      cwd: PLUGIN,
      input: hookInput({
        content: message,
        unshown,
        projectId: "p",
        threadId: "t",
        source: "web",
        placeholders,
      }),
      env: { ...process.env, AGENTD_REDACT_DATA_DIR: data },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return parseHookOutput(result.stdout, message, placeholders, unshown);
  } finally {
    NodeFS.rmSync(data, { recursive: true, force: true });
  }
}

const ID_NUMBER = "110105194912310021";
const FIXTURES = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "redact-files-"));
const DATA = process.env.AGENTD_REDACT_DATA_DIR;
const VENV_PYTHON =
  DATA !== undefined && NodeFS.existsSync(NodePath.join(DATA, "venv", "bin", "python"))
    ? NodePath.join(DATA, "venv", "bin", "python")
    : null;

/** Writes a fixture built by tests/documents.py and points at it as the host would. */
function fixture(id: string, name: string, build: string): HookUnshownAttachment {
  const path = NodePath.join(FIXTURES, name);
  const script = `import sys; sys.path.insert(0, "tests"); import documents; sys.stdout.buffer.write(${build})`;
  NodeFS.writeFileSync(
    path,
    NodeChildProcess.execFileSync("python3", ["-c", script], { cwd: PLUGIN }),
  );
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    sizeBytes: NodeFS.statSync(path).size,
    path,
  };
}
const wordFile = () =>
  fixture(
    "doc",
    "lease.docx",
    `documents.docx(["Tenant ${NAME}, ID number ${ID_NUMBER}."], comment="${EMAIL}")`,
  );
const pdfFile = (text: boolean) =>
  text
    ? fixture("pdf", "intake.pdf", `documents.pdf(["Client: ${NAME}", "ID number ${ID_NUMBER}"])`)
    : fixture("pdf", "scan.pdf", "documents.pdf([])");

afterAll(() => NodeFS.rmSync(FIXTURES, { recursive: true, force: true }));

describe("redaction plugin hook", () => {
  it("declares a before-send hook the host can run", () => {
    const manifest = decodePluginManifest(
      NodeFS.readFileSync(NodePath.join(PLUGIN, "agentd-plugin.json"), "utf8"),
    );
    expect(manifest._tag === "Some" && manifest.value.hooks["before-send"]).toEqual({
      command: ["python3", "hook.py"],
      timeoutSeconds: 60,
      attachmentFiles: true,
    });
  });

  it("rewrites the name, email and key out of the text and the attachment", () => {
    const decision = run("tests/fake_hook.py", []);
    expect(decision._tag).toBe("Rewrite");
    const sent = JSON.stringify(decision._tag === "Rewrite" ? decision.content : null);
    for (const secret of [NAME, EMAIL, API_KEY]) expect(sent).not.toContain(secret);
  });

  it("keeps the thread's placeholders in a second send and numbers a new value after them", () => {
    const first = run("tests/fake_hook.py", []);
    expect(first._tag).toBe("Rewrite");
    const map = first._tag === "Rewrite" ? first.placeholders : {};
    expect(map["[PERSON_1]"]).toBe(NAME);
    const next = { text: `${NAME} wrote from ${EMAIL} and other@example.org.`, attachments: [] };
    const second = run("tests/fake_hook.py", [], [], next, map);
    expect(second._tag === "Rewrite" && second.content.text).toBe(
      "[PERSON_1] wrote from [EMAIL_1] and [EMAIL_2].",
    );
    expect(second._tag === "Rewrite" && second.placeholders["[EMAIL_2]"]).toBe("other@example.org");
  });

  it("passes a message with nothing to redact", () => {
    const plain = {
      text: "Refactor the parser.",
      attachments: [{ id: "a", name: "x.txt", text: "plain" }],
    };
    expect(run("tests/fake_hook.py", [], [], plain)._tag).toBe("Pass");
  });

  it("sends a Word document as its redacted text, with the message's placeholders", () => {
    const decision = run("tests/fake_hook.py", [], [wordFile()], {
      text: `Summarise the lease for ${NAME}.`,
      attachments: [],
    });
    expect(decision._tag).toBe("Rewrite");
    if (decision._tag !== "Rewrite") return;
    const [replaced] = decision.content.attachments;
    expect(replaced).toMatchObject({ id: "doc", name: "lease.docx.txt" });
    expect(replaced!.text).toContain("Tenant [PERSON_1], ID number [ID_1].");
    expect(decision.content.text).toBe("Summarise the lease for [PERSON_1].");
    expect(decision.placeholders).toMatchObject({ "[PERSON_1]": NAME, "[ID_1]": ID_NUMBER });
    for (const secret of [NAME, ID_NUMBER]) {
      expect(JSON.stringify(decision.content)).not.toContain(secret);
    }
  });

  // pypdf is installed by setup_env.py into the plugin's venv, not into the system python.
  it.skipIf(VENV_PYTHON === null)("sends a text PDF as its redacted text", () => {
    const decision = run("tests/fake_hook.py", [], [pdfFile(true)], content, {}, VENV_PYTHON!);
    expect(decision._tag === "Rewrite" && decision.content.attachments.at(-1)).toEqual({
      id: "pdf",
      name: "intake.pdf.txt",
      text: "Client: [PERSON_1]\nID number [ID_1]",
    });
  });

  it.skipIf(VENV_PYTHON === null)("stops a scanned PDF, saying it has no text layer", () => {
    const decision = run("tests/fake_hook.py", [], [pdfFile(false)], content, {}, VENV_PYTHON!);
    expect(decision._tag === "Block" && decision.reason).toContain("scan.pdf has no text layer");
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
