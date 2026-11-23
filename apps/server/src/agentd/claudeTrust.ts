import { AgentdCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// Claude Code stops a worker at "Workspace not trusted" in a folder it never ran in. The app asks
// first and records the answer where Claude Code keeps it: projects[<folder>].hasTrustDialogAccepted
// in CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json. That file also holds the account and
// other settings: nothing of it is logged or returned, and only that one key is ever written.

/** The parts of node:path this needs, so Windows rules can be tested on any host. */
export interface TrustPath {
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly resolve: (...parts: ReadonlyArray<string>) => string;
  readonly normalize: (path: string) => string;
  readonly dirname: (path: string) => string;
  readonly basename: (path: string) => string;
}

export function claudeConfigFile(
  env: { readonly CLAUDE_CONFIG_DIR?: string | undefined },
  home: string,
  path: TrustPath,
): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || home, ".claude.json");
}

/** Claude Code's projects key: the normalized path with forward slashes, on Windows too. */
export function trustKey(folder: string, path: TrustPath): string {
  return path.normalize(path.resolve(folder)).replace(/\\/g, "/");
}

/**
 * The folder Claude Code keys a project by: the main checkout of a Git repository, also for its
 * worktrees (agentd's worker worktrees among them), from `git rev-parse --git-common-dir`.
 */
export function projectFolder(cwd: string, gitCommonDir: string | null, path: TrustPath): string {
  const common = gitCommonDir?.trim();
  if (!common) return cwd;
  const dir = path.resolve(cwd, common);
  return path.basename(dir).toLowerCase() === ".git" ? path.dirname(dir) : cwd;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether Claude Code would run in folder: it or a parent was trusted, as Claude Code checks. */
export function isTrusted(config: unknown, folder: string, path: TrustPath): boolean {
  const projects = isObject(config) ? config.projects : undefined;
  if (!isObject(projects)) return false;
  let current = path.resolve(folder);
  for (;;) {
    const entry = projects[trustKey(current, path)];
    if (isObject(entry) && entry.hasTrustDialogAccepted === true) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The parsed config; {} for an absent or empty file, null when it isn't JSON. */
function parseConfig(text: string | null): unknown {
  if (text === null || text.trim() === "") return {};
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** The config text with folder trusted and every other key as it was; null when it isn't a config. */
export function withTrust(text: string | null, folder: string, path: TrustPath): string | null {
  const config = parseConfig(text);
  if (!isObject(config)) return null;
  const projects = config.projects ?? {};
  if (!isObject(projects)) return null;
  const key = trustKey(folder, path);
  const entry = projects[key] ?? {};
  if (!isObject(entry)) return null;
  const next = {
    ...config,
    projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } },
  };
  // Claude Code writes two-space JSON; a trailing newline the file had is kept.
  return JSON.stringify(next, null, 2) + (text?.endsWith("\n") ? "\n" : "");
}

const notTrusted = (folder: string, why: string) =>
  new AgentdCommandError({
    message: `Couldn’t let Claude Code work in ${folder}: ${why} Open Claude Code in that folder once and accept its trust prompt, then start again.`,
    notSetUp: false,
  });

export const makeClaudeTrust = (deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: TrustPath;
  readonly env: { readonly CLAUDE_CONFIG_DIR?: string | undefined };
  readonly home: string;
}) => {
  const { fs, path } = deps;
  const configFile = claudeConfigFile(deps.env, deps.home, path);

  // A symlinked config is written where it points, so the link stays.
  const target = fs.realPath(configFile).pipe(Effect.orElseSucceed(() => configFile));
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | null => text),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    );

  const trusted = Effect.fn("ClaudeTrust.trusted")(
    function* (folder: string) {
      const text = yield* read(yield* target);
      return text !== null && isTrusted(parseConfig(text), folder, path);
    },
    // An unreadable config is untrusted: the write that follows says why it can't go on.
    Effect.orElseSucceed(() => false),
  );

  const trust = Effect.fn("ClaudeTrust.trust")(function* (folder: string) {
    const file = yield* target;
    const text = yield* read(file).pipe(
      Effect.mapError(() => notTrusted(folder, "Claude Code’s settings file couldn’t be read.")),
    );
    const next = withTrust(text, folder, path);
    if (next === null)
      return yield* notTrusted(folder, "Claude Code’s settings file isn’t in the expected format.");
    const mode =
      text === null
        ? 0o600
        : yield* fs.stat(file).pipe(
            Effect.map((info) => info.mode & 0o777),
            Effect.orElseSucceed(() => 0o600),
          );
    const dir = path.dirname(file);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      // Beside the target, so the rename stays on one filesystem.
      Effect.andThen(fs.makeTempDirectory({ directory: dir, prefix: ".claude.json." })),
      Effect.flatMap((staging) => {
        const staged = path.join(staging, ".claude.json");
        return fs.writeFileString(staged, next).pipe(
          // The config keeps the mode it had; a new one is private.
          Effect.andThen(fs.chmod(staged, mode)),
          Effect.andThen(fs.rename(staged, file)),
          Effect.ensuring(fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
        );
      }),
      Effect.mapError(() => notTrusted(folder, "Claude Code’s settings file couldn’t be written.")),
    );
  });

  return { trusted, trust };
};
