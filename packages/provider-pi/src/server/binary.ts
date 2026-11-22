import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// The app ships Pi (@earendil-works/pi-coding-agent) for people with no Pi of their own. Its CLI is
// a Node script, so it runs on the server's own runtime: Node, or Electron run as Node on desktop.

const BUNDLED_CLI = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
];
const SCRIPT = /\.(?:c|m)?js$/i;

/** The shipped Pi's CLI script, or null when this build has none. */
export const findBundledPiCli = Effect.fn("PiBinary.findBundledPiCli")(function* (
  from: string = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, ...BUNDLED_CLI);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
});

/** Where the shipped Pi is looked for; tests replace it. */
export const BundledPiCli = Context.Reference<
  Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path>
>("t3/provider-pi/BundledPiCli", { defaultValue: () => findBundledPiCli() });

/**
 * The binary an instance runs: a path the user set, else `pi` from PATH, else the shipped Pi.
 * `binaryPath` is the decoded setting, which is "pi" when nothing is set.
 */
export const resolvePiBinaryPath = Effect.fn("PiBinary.resolvePiBinaryPath")(function* (
  binaryPath: string,
  env: NodeJS.ProcessEnv,
) {
  if (binaryPath !== "" && binaryPath !== "pi") return binaryPath;
  if (yield* isCommandAvailable("pi", { env })) return "pi";
  const bundled = yield* yield* BundledPiCli;
  return bundled ?? "pi";
});

/** The command line for `binaryPath`; a script runs on this process's runtime. */
export function piCommandLine(
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const command = binaryPath || "pi";
  if (!SCRIPT.test(command)) return { command, args, env };
  return {
    command: process.execPath,
    args: [command, ...args],
    // Electron's binary is a Node only with this set; the server has it, a trimmed env may not.
    env: process.versions.electron === undefined ? env : { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}
