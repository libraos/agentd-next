// @effect-diagnostics nodeBuiltinImport:off - Runs the release workflow's notes script against fixture notes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

// .github/workflows/release.yml runs this script in prepare (check) and in the draft release (notes).
const root = NodePath.resolve(import.meta.dirname, "..");
const script = NodePath.join(root, "agentd/scripts/release-notes.sh");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

/** A checkout with only the script and the given notes files, as the workflow's sparse checkout. */
const checkout = async (notes: Record<string, string>) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentd-release-notes-"));
  dirs.push(dir);
  await NodeFSP.mkdir(NodePath.join(dir, "agentd/scripts"), { recursive: true });
  await NodeFSP.copyFile(script, NodePath.join(dir, "agentd/scripts/release-notes.sh"));
  await NodeFSP.mkdir(NodePath.join(dir, "docs/release-notes"), { recursive: true });
  for (const [version, text] of Object.entries(notes)) {
    await NodeFSP.writeFile(NodePath.join(dir, "docs/release-notes", `${version}.md`), text);
  }
  return dir;
};

const run = (dir: string, ...args: string[]) =>
  NodeChildProcess.spawnSync(
    "bash",
    [NodePath.join(dir, "agentd/scripts/release-notes.sh"), ...args],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );

describe("agentd/scripts/release-notes.sh", () => {
  it("starts with the version line, then What's new from the release's notes file", async () => {
    const dir = await checkout({ "1.2.3": "- **Plugins.** From a link.\n- Faster start.\n" });
    const result = run(dir, "1.2.3", "v0.1.30");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").slice(0, 7)).toEqual([
      "LibraOS Next 1.2.3, with LibraOS Engine v0.1.30 and its Skills inside.",
      "",
      "**What's new in 1.2.3**",
      "",
      "- **Plugins.** From a link.",
      "- Faster start.",
      "",
    ]);
    expect(result.stdout).toContain("`LibraOS-Next-1.2.3-x64.exe`");
  });

  it("fails naming the file to add when the version has no notes", async () => {
    const dir = await checkout({ "1.2.2": "- Older.\n", "1.2.4": "   \n" });
    for (const version of ["1.2.3", "1.2.4"]) {
      for (const args of [[version], [version, "v0.1.30"]]) {
        const result = run(dir, ...args);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`add docs/release-notes/${version}.md`);
      }
    }
    expect(run(dir, "1.2.2").status).toBe(0);
  });

  it("refuses a version that is not x.y.z, so no path outside docs/release-notes is read", async () => {
    const dir = await checkout({});
    const result = run(dir, "../../etc/passwd", "v0.1.30");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("puts the notes file in the release body literally, running nothing in it", async () => {
    const text = "- $(touch ran-subst) `touch ran-backtick` $HOME ${VERSION} \\n %s EOF\nEOF\n";
    const dir = await checkout({ "1.2.3": text });
    const result = run(dir, "1.2.3", "v0.1.30");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `**What's new in 1.2.3**\n\n${text}\n**Which file to download**`,
    );
    expect(NodeFS.existsSync(NodePath.join(dir, "ran-subst"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(dir, "ran-backtick"))).toBe(false);
  });

  it("keeps old names out of the fixed text and names 0.4.0 as the first notarized macOS release", async () => {
    const dir = await checkout({ "1.2.3": "- A change.\n" });
    const notes = run(dir, "1.2.3", "v0.1.30").stdout;
    // 0.1.10-agentd.8 is a version number, not a name.
    expect(notes.replaceAll("0.1.10-agentd.8", "")).not.toMatch(/agentd/i);
    expect(notes).toContain("On macOS, 0.4.0 and later (signed and notarized) update in place");
    const paragraphs = notes.split("\n\n").map((paragraph) => paragraph.trim());
    expect(new Set(paragraphs).size).toBe(paragraphs.length);
    const earlier = paragraphs.filter((paragraph) => paragraph.includes("earlier version"));
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).not.toContain("\n");
  });

  it("has the notes file of 0.4.1, and each notes file is named by a release version", () => {
    const files = NodeFS.readdirSync(NodePath.join(root, "docs/release-notes"));
    expect(files).toContain("0.4.1.md");
    for (const file of files) expect(file).toMatch(/^\d+\.\d+\.\d+\.md$/);
  });
});
