// @effect-diagnostics nodeBuiltinImport:off -- Node's TLS trust store is process-global and the fresh read is a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** binMain's fast path that prints the system store as a JSON array of PEM strings. */
const SYSTEM_CERTIFICATES_COMMAND = "__system-certificates";

// Bundled roots (or the system's under --use-system-ca) plus NODE_EXTRA_CA_CERTS, before any change.
const startupRoots = NodeTls.getCACertificates("default");

/** Trusts `system` beside the roots Node started with; Node's `fetch` and `https` read this default. */
export function trustCertificates(system: ReadonlyArray<string>): void {
  // Older Electron Node lacks this; it keeps Node's defaults.
  if (typeof NodeTls.setDefaultCACertificates !== "function") return;
  NodeTls.setDefaultCACertificates([...new Set([...startupRoots, ...system])]);
}

/**
 * At start: trust the system store, which Node reads once per process, and have every agent the
 * server starts do the same. An explicit `NODE_USE_SYSTEM_CA` is kept.
 */
export function trustSystemCertificates(environment: NodeJS.ProcessEnv): void {
  environment.NODE_USE_SYSTEM_CA ??= "1";
  try {
    trustCertificates(NodeTls.getCACertificates("system"));
  } catch {
    // A store Node cannot read leaves the bundled roots, as before.
  }
}

class SystemCertificatesReadError extends Schema.TaggedError<SystemCertificatesReadError>()(
  "SystemCertificatesReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the system certificate store.";
  }
}

const readPemList = (stdout: string): ReadonlyArray<string> | null => {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  } catch {
    return null;
  }
};

/**
 * Reads the system store again in a new process, since this one keeps its first read, and trusts
 * it, so a CA installed while the server runs counts without a restart. Never fails: a store that
 * cannot be read leaves the trust as it was.
 */
export const refreshSystemCertificates = Effect.fn("SystemCertificates.refresh")(function* () {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  // In a bundle import.meta.url is bin.mjs; development and tests use this source module.
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  const stdout = yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          executable,
          [...(isExecutable ? [] : [entry]), SYSTEM_CERTIFICATES_COMMAND],
          {
            signal,
            timeout: 15_000,
            maxBuffer: 32 * 1024 * 1024,
            encoding: "utf8",
            windowsHide: true,
            env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
          },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
      }),
    catch: (cause) => new SystemCertificatesReadError({ cause }),
  }).pipe(Effect.result);
  const system = stdout._tag === "Success" ? readPemList(stdout.success) : null;
  if (system === null) {
    const cause = stdout._tag === "Failure" ? stdout.failure : "unreadable output";
    yield* Effect.logWarning("Could not read the system certificate store again.", { cause });
    return;
  }
  trustCertificates(system);
});

/** How a gateway check re-reads the system store; tests replace it. */
export const SystemCertificateRefresh = Context.Reference<Effect.Effect<void>>(
  "t3/agentd/SystemCertificateRefresh",
  { defaultValue: () => refreshSystemCertificates() },
);

// Errors a CA added to the system store can fix; expiry or a wrong host need the gateway fixed.
const UNTRUSTED_ISSUER_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

// fetch wraps Node's error in TypeErrors, and effect's client wraps those again.
const nodeErrorCode = (cause: unknown) => {
  const seen = new Set<unknown>();
  for (let error = cause; typeof error === "object" && error !== null && !seen.has(error);) {
    seen.add(error);
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = (error as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

/** What to say when `error` is a TLS certificate failure, else null. */
export function certificateProblem(
  error: unknown,
  gateway: { readonly name: string; readonly host: string },
): string | null {
  const code = nodeErrorCode(error);
  if (code === undefined) return null;
  const subject = `${gateway.name}'s certificate at ${gateway.host} isn't trusted`;
  if (UNTRUSTED_ISSUER_CODES.has(code)) {
    return `${subject}: this computer doesn't trust the authority that signed it (${code}). If it comes from your organization's own certificate authority, add that authority to this computer's certificate store, then try again.`;
  }
  if (code.includes("CERT")) return `${subject} (${code}).`;
  return null;
}
