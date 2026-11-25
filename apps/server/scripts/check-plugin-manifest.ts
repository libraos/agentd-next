// @effect-diagnostics nodeBuiltinImport:off - a command-line check that reads one file.
// The body of scripts/check-plugin-manifest.ts: the parser the app uses on install, over a folder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PLUGIN_MANIFEST_FILE, parsePluginManifest } from "../src/agentd/pluginCatalog.ts";

const fail = (lines: ReadonlyArray<string>) => {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
};

const [folder] = process.argv.slice(2);
if (folder === undefined) fail(["usage: node scripts/check-plugin-manifest.ts DIR"]);
const file = NodePath.join(folder ?? "", PLUGIN_MANIFEST_FILE);
let text = "";
try {
  text = NodeFS.readFileSync(file, "utf8");
} catch {
  fail([`${file}: cannot be read.`]);
}
const parsed = parsePluginManifest(text);
if (parsed._tag === "Invalid") {
  fail([
    `${file} is not a valid plugin manifest:`,
    ...parsed.reasons.map((reason) => `- ${reason}`),
  ]);
} else {
  process.stdout.write(`${file}: ${parsed.manifest.id} ${parsed.manifest.version} is valid.\n`);
}
