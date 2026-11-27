// Ported from Orca (https://github.com/stablyai/orca, MIT License), file
// src/main/mcp-servers/agent-configs/agent-config-file-write.ts at commit
// bf0997cfed9e0ac10e73ee98c5179c87d4329743, onto Effect's FileSystem. Only the parts used here.

// An edit is published only while the file still holds the text it was made from, after that text
// is copied to a rolling `.bak`. The agent may save at any moment, so the file is taken aside for
// its last check and the edit goes in only where no newer save took the name.

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Sync digests and ids keep the names plain.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  message: Schema.String,
}) {}

/** The parts of node:path this needs. */
export interface ConfigFilePath {
  readonly dirname: (path: string) => string;
  readonly resolve: (...parts: ReadonlyArray<string>) => string;
}

const MAX_LINK_HOPS = 8;

const isReason = (error: unknown, tag: PlatformError.SystemErrorTag) =>
  PlatformError.isPlatformError(error) &&
  error.reason._tag !== "BadArgument" &&
  error.reason._tag === tag;
const isAbsence = (error: unknown) => isReason(error, "NotFound");

/** Where a config waits while its edit is published; only this app writes this name. */
const heldPathOf = (target: string) => `${target}.agentd-publishing`;

// One read or publish of a config at a time in this process, so none sees it while it's held.
const queues = new Map<string, Semaphore.Semaphore>();
const oneAtATime =
  (target: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    let queue = queues.get(target);
    if (queue === undefined) {
      queue = Semaphore.makeUnsafe(1);
      queues.set(target, queue);
    }
    return queue.withPermits(1)(effect);
  };

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export const makeConfigFiles = (deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: ConfigFilePath;
  readonly platform: NodeJS.Platform;
  readonly newId?: (() => string) | undefined;
}) => {
  const { fs, path, platform } = deps;
  const newId = deps.newId ?? NodeCrypto.randomUUID;
  const windows = platform === "win32";

  const lstatIfPresent = (file: string) =>
    fs.lstat(file).pipe(
      Effect.map((info): FileSystem.File.Info | null => info),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    );

  // Windows refuses a rename while a scanner or the agent briefly holds the file open.
  const rename = (from: string, to: string) =>
    fs.rename(from, to).pipe(
      Effect.retry({
        while: (error) =>
          windows && (isReason(error, "Busy") || isReason(error, "PermissionDenied")),
        schedule: Schedule.spaced("50 millis"),
        times: 20,
      }),
    );

  /** The file `file` names after its dotfile symlinks, even while that file is held aside. */
  const publishedPath = Effect.fnUntraced(function* (file: string) {
    let current = file;
    for (let hop = 0; ; hop++) {
      if ((yield* lstatIfPresent(current))?.type !== "SymbolicLink") return current;
      if (hop === MAX_LINK_HOPS) {
        return yield* new ConfigFileError({ message: `Too many symbolic links: ${file}` });
      }
      // A relative link is read from its folder's real place, which may itself be a link.
      current = path.resolve(
        yield* fs.realPath(path.dirname(current)),
        yield* fs.readLink(current),
      );
    }
  });

  /** False when `to` exists. A symlink stays one: macOS's link() would follow it. */
  const linkWithoutReplacing = (from: string, to: string) =>
    fs.lstat(from).pipe(
      Effect.flatMap((info) =>
        info.type === "SymbolicLink"
          ? fs.readLink(from).pipe(Effect.flatMap((link) => fs.symlink(link, to)))
          : fs.link(from, to),
      ),
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );

  /**
   * Puts a file a stopped publish left held back at `file`, never over a newer save there; that one
   * stays and the held bytes are kept beside it as `<file>.agentd-kept-<content hash>`. Fails,
   * leaving it held for the next try, when neither name is free.
   */
  const restoreHeld = Effect.fnUntraced(function* (held: string, file: string) {
    const bytes = yield* fs
      .readFile(held)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (bytes === null) return;
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const kept = `${file}.agentd-kept-${hash}`;
    for (const target of [file, kept]) {
      const there = yield* fs.readFile(target).pipe(Effect.orElseSucceed(() => null));
      const placed =
        there === null ? yield* linkWithoutReplacing(held, target) : sameBytes(there, bytes);
      if (!placed) continue;
      yield* fs.remove(held, { force: true });
      if (target === kept)
        yield* Effect.logWarning("Kept an earlier version beside", { file, kept });
      return;
    }
    return yield* new ConfigFileError({
      message: `Could not put back an earlier version of ${file}`,
    });
  });

  /** Moves `source` over the rolling `.bak`, never through a symlinked one. */
  const replaceBackup = Effect.fnUntraced(function* (source: string, backup: string) {
    const previous = yield* lstatIfPresent(backup);
    if (previous?.type === "SymbolicLink") {
      return yield* new ConfigFileError({
        message: `Refusing to overwrite symlinked backup: ${backup}`,
      });
    }
    if (windows) {
      // copyFile keeps a read-only attribute, and Windows refuses to rename over a read-only file.
      yield* fs.chmod(source, 0o666);
      if (previous?.type === "File" && (previous.mode & 0o200) === 0)
        yield* fs.chmod(backup, 0o666);
    }
    yield* rename(source, backup);
  });

  /**
   * Refuses a drive with no hard links (FAT/exFAT, \\wsl$): nothing there publishes without
   * possibly replacing a newer save, so the config is never taken aside on it.
   */
  const assertHardLinks = (target: string) => {
    const probe = `${target}.${newId()}.link-probe`;
    return fs.link(target, probe).pipe(
      Effect.mapError((error) =>
        isAbsence(error)
          ? error
          : new ConfigFileError({ message: `${target} can't be edited safely on this drive.` }),
      ),
      Effect.ensuring(fs.remove(probe, { force: true }).pipe(Effect.ignore)),
    );
  };

  /** The file's text (BOM kept), or null when it is absent. */
  const read = Effect.fn("ConfigFiles.read")(function* (file: string) {
    const target = yield* publishedPath(file);
    return yield* Effect.gen(function* () {
      // The app stopped while publishing an edit: the config goes back before anyone reads it.
      if ((yield* lstatIfPresent(heldPathOf(target))) !== null) {
        yield* restoreHeld(heldPathOf(target), target);
      }
      return yield* fs.readFileString(file).pipe(
        Effect.map((text): string | null => text),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      );
    }).pipe(oneAtATime(target));
  });

  /**
   * Runs `publish` with the config at `target` held aside, once its bytes are still `computedFrom`;
   * false when they aren't (put back) or when a newer file took the name meanwhile (it stays).
   */
  const withConfigHeld = (
    target: string,
    computedFrom: string,
    publish: Effect.Effect<boolean, PlatformError.PlatformError>,
  ) => {
    const held = heldPathOf(target);
    return Effect.gen(function* () {
      const taken = yield* assertHardLinks(target).pipe(
        Effect.andThen(rename(target, held)),
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      if (!taken) return false;
      const outcome = yield* Effect.exit(
        fs
          .readFile(held)
          .pipe(
            Effect.flatMap((bytes) =>
              sameBytes(bytes, new TextEncoder().encode(computedFrom))
                ? publish
                : Effect.succeed(false),
            ),
          ),
      );
      // Published: the held bytes are the `.bak` already. Else they go back.
      if (Exit.isSuccess(outcome) && outcome.value) {
        yield* fs.remove(held, { force: true }).pipe(Effect.ignore);
      } else {
        yield* restoreHeld(held, target);
      }
      return yield* outcome;
    }).pipe(Effect.uninterruptible, oneAtATime(target));
  };

  /** A config that was absent: created only while it still is, private from its first byte. */
  const create = Effect.fnUntraced(function* (target: string, contents: string) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const temp = `${target}.${newId()}.tmp`;
    return yield* fs
      .writeFileString(temp, contents, { mode: 0o600, flag: "wx" })
      .pipe(
        Effect.andThen(windows ? Effect.void : fs.chmod(temp, 0o600)),
        Effect.andThen(linkWithoutReplacing(temp, target).pipe(oneAtATime(target))),
        Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
      );
  });

  /**
   * Replaces `file` (a dotfile symlink's target) with `contents`; false, writing nothing, when the
   * file no longer holds `computedFrom` (null: it was absent), so the caller redoes its edit on the
   * newer save.
   */
  const writeIfUnchanged = Effect.fn("ConfigFiles.writeIfUnchanged")(function* (
    file: string,
    contents: string,
    computedFrom: string | null,
  ) {
    const target = yield* publishedPath(file);
    if (computedFrom === null) return yield* create(target, contents);
    const info = yield* fs.stat(target).pipe(
      Effect.map((stat): FileSystem.File.Info | null => stat),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    );
    if (info === null) return false;
    const mode = info.mode & 0o777;
    const temp = `${target}.${newId()}.tmp`;
    const backupTemp = `${target}.bak.${newId()}.tmp`;
    return yield* Effect.gen(function* () {
      // Agent configs can hold tokens: the new file and the backup keep the old one's permissions.
      yield* fs.writeFileString(temp, contents, { mode, flag: "wx" });
      if (!windows) yield* fs.chmod(temp, mode);
      yield* fs.copyFile(target, backupTemp);
      if (!windows) yield* fs.chmod(backupTemp, mode);
      // A save that lands while the copy is made keeps the previous backup and refuses the edit.
      if ((yield* read(target)) !== computedFrom) return false;
      yield* replaceBackup(backupTemp, `${target}.bak`);
      return yield* withConfigHeld(target, computedFrom, linkWithoutReplacing(temp, target));
    }).pipe(
      // Best effort: a Windows scanner holding the published file's second name must not fail it.
      Effect.ensuring(
        Effect.forEach([temp, backupTemp], (name) => fs.remove(name, { force: true }), {
          discard: true,
        }).pipe(Effect.ignore),
      ),
    );
  });

  return { read, writeIfUnchanged };
};

export type ConfigFiles = ReturnType<typeof makeConfigFiles>;
