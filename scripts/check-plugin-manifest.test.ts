// @effect-diagnostics nodeBuiltinImport:off - runs the script as the catalogue will.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "check-plugin-manifest.ts");
const check = (folder: string) =>
  NodeChildProcess.spawnSync(process.execPath, [script, folder], { encoding: "utf8" });

it("exits 0 for a valid folder and 1 with the reasons for an invalid one", () => {
  const valid = check(
    NodePath.join(import.meta.dirname, "../apps/server/src/agentd/__fixtures__/mcp-plugin"),
  );
  expect(valid.status).toBe(0);

  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "plugin-manifest-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(folder, "agentd-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "x",
        name: "X",
        version: "1.0.0",
        contributes: { mcpServers: { x: { args: [] } } },
      }),
    );
    const invalid = check(folder);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('["contributes"]["mcpServers"]["x"]["command"]: Missing key');
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});
