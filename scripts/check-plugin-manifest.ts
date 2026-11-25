// @effect-diagnostics nodeBuiltinImport:off - a command-line check that reads one file.
// Checks a plugin folder's agentd-plugin.json with the parser the app uses on install.
//
//   node scripts/check-plugin-manifest.ts DIR
//
// Exit 0 when it is valid; 1 with one reason per line when it is not or cannot be read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PLUGIN_MANIFEST_FILE,
  parsePluginManifest,
} from "../apps/server/src/agentd/pluginCatalog.ts";

const [folder] = process.argv.slice(2);
if (folder === undefined) {
  console.error("usage: node scripts/check-plugin-manifest.ts DIR");
  process.exit(1);
}
const file = NodePath.join(folder, PLUGIN_MANIFEST_FILE);
let text: string;
try {
  text = NodeFS.readFileSync(file, "utf8");
} catch {
  console.error(`${file}: cannot be read.`);
  process.exit(1);
}
const parsed = parsePluginManifest(text);
if (parsed._tag === "Invalid") {
  console.error(`${file} is not a valid plugin manifest:`);
  for (const reason of parsed.reasons) console.error(`- ${reason}`);
  process.exit(1);
}
console.log(`${file}: ${parsed.manifest.id} ${parsed.manifest.version} is valid.`);
