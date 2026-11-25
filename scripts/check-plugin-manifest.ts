// Checks a plugin folder's agentd-plugin.json with the parser the app uses on install.
//
//   node scripts/check-plugin-manifest.ts DIR
//
// Exit 0 when it is valid; 1 with one reason per line when it is not or cannot be read.
// The body lives in apps/server, whose project typechecks the parser it imports.
await import(new URL("../apps/server/scripts/check-plugin-manifest.ts", import.meta.url).href);
