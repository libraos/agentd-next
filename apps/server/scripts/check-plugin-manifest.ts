// @effect-diagnostics nodeBuiltinImport:off - a command-line check that reads a folder's files.
// The body of scripts/check-plugin-manifest.ts: the parser the app uses on install, over a folder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CLAUDE_MCP_FILE,
  CLAUDE_PLUGIN_FILE,
  parsePluginFiles,
} from "../src/agentd/claudePluginFormat.ts";
import { PLUGIN_MANIFEST_FILE } from "../src/agentd/pluginCatalog.ts";

const fail = (lines: ReadonlyArray<string>) => {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
};

const [folder] = process.argv.slice(2);
if (folder === undefined) fail(["usage: node scripts/check-plugin-manifest.ts DIR"]);
const read = (file: string) => {
  try {
    return NodeFS.readFileSync(NodePath.join(folder ?? "", file), "utf8");
  } catch {
    return undefined;
  }
};
const parsed = parsePluginFiles({
  plugin: read(CLAUDE_PLUGIN_FILE),
  mcp: read(CLAUDE_MCP_FILE),
  sidecar: read(PLUGIN_MANIFEST_FILE),
});
if (parsed._tag === "Invalid") {
  fail([`${folder} is not a valid plugin:`, ...parsed.reasons.map((reason) => `- ${reason}`)]);
} else {
  process.stdout.write(`${folder}: ${parsed.plugin.id} ${parsed.plugin.version} is valid.\n`);
}
