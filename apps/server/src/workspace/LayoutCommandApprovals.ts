import { ProjectId, TaskFolderError, type WorktreeLayoutCommandKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { isWithinRoot } from "./KnownWorkspaces.ts";

/**
 * Which of a project's `worktreeLayout` commands a person approved, by the hash of the exact
 * text and of the repository files that text names. This side only reads. Recording an approval
 * is `LayoutCommandApprovalWrites`, which only the client RPC that a person's session calls may
 * import (t3code/no-layout-command-approval-writes).
 */
export class LayoutCommandApprovals extends Context.Service<
  LayoutCommandApprovals,
  {
    /** `projectRoot` is the folder the command runs in, where the files it names are found. */
    readonly isApproved: (input: {
      readonly projectId: ProjectId;
      readonly projectRoot: string;
      readonly kind: WorktreeLayoutCommandKind;
      readonly command: string;
    }) => Effect.Effect<boolean, TaskFolderError>;
    /** The repository files `command` names now, relative to `projectRoot`, which an approval covers. */
    readonly repositoryFiles: (input: {
      readonly projectRoot: string;
      readonly command: string;
    }) => Effect.Effect<ReadonlyArray<string>, TaskFolderError>;
  }
>()("t3/workspace/LayoutCommandApprovals") {}

export const failed = (cause: unknown) =>
  new TaskFolderError({
    operation: "approve",
    detail: "Could not read the worktree layout command approvals.",
    cause,
  });

const sha256 = (digest: Digest.Digest["Service"], bytes: Uint8Array) =>
  digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode), Effect.mapError(failed));

/** What an approval is of: the text itself, so one changed character asks again. */
export const commandHash = (digest: Digest.Digest["Service"], command: string) =>
  sha256(digest, new TextEncoder().encode(command));

/**
 * The words of a command that may name a file: split as a shell would on blanks and operators,
 * quotes kept together, and the value of `--flag=value` or `NAME=value` too. A word with a
 * variable or a glob in it names nothing this side can know, so it is left out.
 */
export const commandPathCandidates = (command: string): ReadonlyArray<string> => {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/[\s;&|()<>`]/.test(char)) {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word !== "") words.push(word);
  const candidates = new Set<string>();
  for (const found of words) {
    if (/[$%*?]/.test(found)) continue;
    const value = found.slice(found.indexOf("=") + 1);
    for (const candidate of [found, value]) {
      if (candidate !== "" && !candidate.startsWith("-")) candidates.add(candidate);
    }
  }
  return [...candidates];
};

/**
 * The content hash of each repository file `command` names, by its path from `projectRoot` with
 * `/` separators. Only a path inside the project root is looked at. A link inside it that leads
 * out is recorded by where it leads, never read.
 */
export const repositoryFileHashes = Effect.fnUntraced(function* (
  projectRoot: string,
  command: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const root = path.resolve(projectRoot);
  const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
  const hashes: Record<string, string> = {};
  for (const candidate of commandPathCandidates(command)) {
    const target = path.resolve(root, candidate);
    if (target === root || !isWithinRoot(path, target, root)) continue;
    const relative = path.relative(root, target).split(path.sep).join("/");
    if (relative in hashes) continue;
    const real = yield* fileSystem.realPath(target).pipe(Effect.option);
    if (Option.isNone(real)) continue;
    if (!isWithinRoot(path, real.value, realRoot)) {
      hashes[relative] = yield* sha256(digest, new TextEncoder().encode(`link:${real.value}`));
      continue;
    }
    const info = yield* fileSystem.stat(real.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") continue;
    const content = yield* fileSystem.readFile(real.value).pipe(Effect.mapError(failed));
    hashes[relative] = yield* sha256(digest, content);
  }
  return Object.fromEntries(
    Object.entries(hashes).toSorted(([left], [right]) => left.localeCompare(right)),
  );
});

/**
 * What an approval is of: the command's text and the content of each repository file it names,
 * so one changed character in either asks again. With no file named it is the text's hash alone,
 * as every approval was before files counted, so those stay valid exactly while that holds.
 */
export const approvalHash = (
  digest: Digest.Digest["Service"],
  command: string,
  fileHashes: Readonly<Record<string, string>>,
) =>
  Object.keys(fileHashes).length === 0
    ? commandHash(digest, command)
    : commandHash(digest, JSON.stringify({ command, files: fileHashes }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Digest.Digest>();

  const findHash = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, kind: Schema.String }),
    Result: Schema.Struct({ commandHash: Schema.String }),
    execute: ({ projectId, kind }) => sql`
      SELECT command_hash AS "commandHash" FROM layout_command_approvals
      WHERE project_id = ${projectId} AND kind = ${kind}
    `,
  });
  const fileHashesNow = (projectRoot: string, command: string) =>
    repositoryFileHashes(projectRoot, command).pipe(Effect.provide(services));

  return LayoutCommandApprovals.of({
    isApproved: Effect.fn("LayoutCommandApprovals.isApproved")(function* (input) {
      const approved = yield* findHash(input).pipe(Effect.mapError(failed));
      if (approved._tag === "None") return false;
      const files = yield* fileHashesNow(input.projectRoot, input.command);
      return approved.value.commandHash === (yield* approvalHash(digest, input.command, files));
    }),
    repositoryFiles: Effect.fn("LayoutCommandApprovals.repositoryFiles")(function* (input) {
      return Object.keys(yield* fileHashesNow(input.projectRoot, input.command));
    }),
  });
});

export const layer = Layer.effect(LayoutCommandApprovals, make);
