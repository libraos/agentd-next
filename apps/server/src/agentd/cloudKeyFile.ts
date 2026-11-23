// @effect-diagnostics-next-line nodeBuiltinImport:off -- O_NONBLOCK, which Effect's open can't pass.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fstat, fchmod and read on one descriptor.
import * as NodeFSP from "node:fs/promises";

import {
  AgentdCommandError,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudKeyFileInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// Which provider's key a Cloud Workers key file holds, read from its first bytes only, before the
// key reaches a cloud worker that would refuse it minutes later. Nothing read is logged or sent:
// only the provider's name leaves this module. agentd-core#978 adds this check to agentd itself;
// once the bundled agentd answers it, its answer replaces this one.

// agentd trims leading whitespace before the key, so some of it is read past; "sk-ant-" after
// that is enough to tell the two prefixes apart.
const PREFIX_BYTES = 4096;
const OPEN_TO_OTHERS = 0o077;
const EXECUTABLE = 0o111;
// A provider key, a Claude setup-token or Codex's auth.json is a few KiB at most.
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const PRIVATE_MODE = 0o600;
// Non-blocking, so a named pipe at the path cannot hold the open waiting for a writer.
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);

export function keyFileProvider(prefix: string): AgentdCloudKeyFileCheck["provider"] {
  // trimStart drops a byte order mark too.
  const text = prefix.trimStart();
  if (text.startsWith("sk-ant-")) return "anthropic";
  // Cut off before "sk-ant-" is whole: either provider's, so neither.
  if ("sk-ant-".startsWith(text)) return null;
  return text.startsWith("sk-") ? "openai" : null;
}

// Codex's auth.json: an object with its sign-in tokens, API key or auth mode. Any other JSON is
// someone's config, which a host-wide repair must not lock away from its other readers.
function isCodexAuth(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const auth = parsed as Record<string, unknown>;
  return (
    (typeof auth.tokens === "object" && auth.tokens !== null) ||
    typeof auth.OPENAI_API_KEY === "string" ||
    typeof auth.auth_mode === "string"
  );
}

const unreadable: AgentdCloudKeyFileCheck = {
  provider: null,
  readable: false,
  openToOthers: false,
};

// A failed call on the descriptor is "couldn't", which each caller turns into its own answer.
const orNull = <A>(attempt: () => Promise<A>) =>
  Effect.tryPromise({ try: attempt, catch: () => "failed" as const }).pipe(
    Effect.orElseSucceed(() => null),
  );

const notChanged = (path: string, why: string) =>
  new AgentdCommandError({
    message: `Couldn’t change the permissions of ${path}: ${why}`,
    notSetUp: false,
  });

export const makeCloudKeyFile = (deps: {
  readonly isAbsolute: (path: string) => boolean;
  readonly platform: string;
  /** The server's own user; a file of anyone else's is never changed. */
  readonly uid: number | undefined;
}) => {
  const { isAbsolute, platform, uid } = deps;
  const checkModes = platform !== "win32";

  // Everything happens on one descriptor: what is checked is what is read and what is changed.
  // A repair that can't finish fails, so the refusal it was asked to fix stays on screen.
  const inspect = (path: string, makePrivate: boolean) =>
    Effect.acquireUseRelease(
      orNull(() => NodeFSP.open(path, OPEN_FLAGS)),
      (file) =>
        Effect.gen(function* () {
          if (file === null) {
            if (makePrivate) return yield* notChanged(path, "it couldn’t be opened.");
            return unreadable;
          }
          const info = yield* orNull(() => file.stat());
          if (info === null || !info.isFile()) {
            if (makePrivate) return yield* notChanged(path, "it is not a regular file.");
            return unreadable;
          }
          const bytes = new Uint8Array(PREFIX_BYTES);
          const read = yield* orNull(() => file.read(bytes, 0, PREFIX_BYTES, 0));
          if (read === null) {
            if (makePrivate) return yield* notChanged(path, "it couldn’t be read.");
            return unreadable;
          }
          const prefix = new TextDecoder().decode(bytes.subarray(0, read.bytesRead));
          const provider = keyFileProvider(prefix);
          let mode = info.mode;
          if (makePrivate && checkModes && (mode & OPEN_TO_OTHERS) !== 0) {
            if (uid !== undefined && info.uid !== uid)
              return yield* notChanged(path, "it belongs to another user.");
            // Only a file that looks like a credential: never a program, a document or a config.
            let credential =
              (mode & EXECUTABLE) === 0 && info.size <= MAX_CREDENTIAL_BYTES && provider !== null;
            if (!credential && (mode & EXECUTABLE) === 0 && info.size <= MAX_CREDENTIAL_BYTES) {
              const whole = new Uint8Array(info.size);
              const all = /^\s*\{/.test(prefix)
                ? yield* orNull(() => file.read(whole, 0, whole.length, 0))
                : null;
              credential =
                all !== null &&
                isCodexAuth(new TextDecoder().decode(whole.subarray(0, all.bytesRead)));
            }
            if (!credential)
              return yield* notChanged(
                path,
                "it doesn’t look like a key or token file. Run chmod 600 on it in a terminal if it is one.",
              );
            yield* Effect.tryPromise({
              try: () => file.chmod(PRIVATE_MODE),
              catch: () => notChanged(path, "run chmod 600 on it in a terminal, then try again."),
            });
            mode = PRIVATE_MODE;
          }
          return {
            provider,
            readable: true,
            openToOthers: checkModes && (mode & OPEN_TO_OTHERS) !== 0,
          } satisfies AgentdCloudKeyFileCheck;
        }),
      (file) => (file === null ? Effect.void : orNull(() => file.close())),
    );

  return Effect.fn("AgentdCloud.keyFile")(function* (
    { path }: AgentdCloudKeyFileInput,
    makePrivate: boolean,
  ) {
    if (!isAbsolute(path))
      return yield* new AgentdCommandError({
        message: "Enter the absolute path of the key file on the selected machine.",
        notSetUp: false,
      });
    return yield* inspect(path, makePrivate);
  });
};
