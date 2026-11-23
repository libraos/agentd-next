// @effect-diagnostics nodeBuiltinImport:off -- Runs before the Clerk bridge registers its privileged scheme, so it must not yield to Electron's ready event.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** LibraOS Next's Electron profile folder in the OS app data folder (`-dev` in development). */
const USER_DATA_DIRECTORY_NAME = "libraos-next";
/** AgentD Next's, copied once into the new folder and never changed. */
const LEGACY_USER_DATA_DIRECTORY_NAME = "agentd-desktop";

export const userDataDirectoryName = (isDevelopment: boolean): string =>
  isDevelopment ? `${USER_DATA_DIRECTORY_NAME}-dev` : USER_DATA_DIRECTORY_NAME;

const legacyUserDataDirectoryName = (isDevelopment: boolean): string =>
  isDevelopment ? `${LEGACY_USER_DATA_DIRECTORY_NAME}-dev` : LEGACY_USER_DATA_DIRECTORY_NAME;

// Chromium's profile lock (symlinks on Linux and macOS, a file on Windows) and caches it rebuilds.
const SKIPPED_NAMES = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
]);

const STAGING_INFIX = ".partial-";

export type LegacyUserDataMigration =
  | {
      readonly _tag: "Copied";
      readonly from: string;
      readonly to: string;
      readonly skipped: number;
    }
  | { readonly _tag: "AlreadyPresent" }
  | { readonly _tag: "NoLegacyProfile" }
  | { readonly _tag: "LegacyProfileNotADirectory"; readonly from: string };

export class LegacyUserDataMigrationError extends Schema.TaggedError<LegacyUserDataMigrationError>()(
  "LegacyUserDataMigrationError",
  { from: Schema.String, to: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the AgentD Next profile from ${this.from} to ${this.to}.`;
  }
}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

function lstatIfExists(path: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

// A file that vanished or cannot be read is left behind rather than failing the whole copy.
const isSkippableCopyError = (error: unknown) => {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
};

/** Copies regular files and directories only; symbolic links and special files are neither copied nor followed. */
function copyTree(source: string, destination: string, mode: number): number {
  NodeFS.mkdirSync(destination, { mode });
  let skipped = 0;
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    try {
      // Re-read without following links: the entry may have been replaced since readdir.
      const stat = NodeFS.lstatSync(from);
      if (stat.isDirectory()) {
        skipped += copyTree(from, to, stat.mode & 0o777);
      } else if (stat.isFile()) {
        // Keeps the source's permission bits, so a 0600 token file stays 0600.
        NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
      } else {
        skipped++;
      }
    } catch (error) {
      if (!isSkippableCopyError(error)) throw error;
      skipped++;
    }
  }
  return skipped;
}

/**
 * Copies AgentD Next's profile folder to LibraOS Next's when only the old one exists. The old folder
 * is never moved, changed or deleted, and an existing new folder is never written to. The copy is
 * built beside the new folder (private to the user) and renamed into place, so an interrupted copy
 * is never taken for a finished one.
 */
export function copyLegacyUserData(input: {
  readonly appDataDirectory: string;
  readonly isDevelopment: boolean;
}): LegacyUserDataMigration {
  const targetName = userDataDirectoryName(input.isDevelopment);
  const target = NodePath.join(input.appDataDirectory, targetName);
  const legacy = NodePath.join(
    input.appDataDirectory,
    legacyUserDataDirectoryName(input.isDevelopment),
  );
  const stagingPrefix = `${targetName}${STAGING_INFIX}`;

  if (lstatIfExists(input.appDataDirectory) === undefined) return { _tag: "NoLegacyProfile" };
  for (const entry of NodeFS.readdirSync(input.appDataDirectory, { withFileTypes: true })) {
    // Left by a copy that was interrupted; rmSync removes a link itself, never its target.
    if (entry.name.startsWith(stagingPrefix)) {
      NodeFS.rmSync(NodePath.join(input.appDataDirectory, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  if (lstatIfExists(target) !== undefined) return { _tag: "AlreadyPresent" };
  const legacyStat = lstatIfExists(legacy);
  if (legacyStat === undefined) return { _tag: "NoLegacyProfile" };
  // A linked profile folder points outside the app data folder; it is left for the person to copy.
  if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
    return { _tag: "LegacyProfileNotADirectory", from: legacy };
  }

  const staging = NodePath.join(input.appDataDirectory, `${stagingPrefix}${process.pid}`);
  try {
    const skipped = copyTree(legacy, staging, 0o700);
    NodeFS.renameSync(staging, target);
    return { _tag: "Copied", from: legacy, to: target, skipped };
  } catch (error) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    // Another instance finished its copy first.
    if (lstatIfExists(target) !== undefined) return { _tag: "AlreadyPresent" };
    throw error;
  }
}

export const migrateLegacyUserData = Effect.fn("desktop.userData.migrateLegacy")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const result = yield* Effect.try({
      try: () => copyLegacyUserData(input),
      catch: (cause) =>
        new LegacyUserDataMigrationError({
          from: NodePath.join(
            input.appDataDirectory,
            legacyUserDataDirectoryName(input.isDevelopment),
          ),
          to: NodePath.join(input.appDataDirectory, userDataDirectoryName(input.isDevelopment)),
          cause,
        }),
    });
    if (result._tag === "Copied") {
      yield* Effect.logInfo("copied the AgentD Next profile", result);
    } else if (result._tag === "LegacyProfileNotADirectory") {
      yield* Effect.logWarning("the AgentD Next profile is a link; not copied", result);
    }
    return result;
  },
  (effect) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { cause: String(error.cause) }).pipe(Effect.as(undefined)),
      ),
    ),
);
