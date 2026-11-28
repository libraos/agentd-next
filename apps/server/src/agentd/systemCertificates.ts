// @effect-diagnostics nodeBuiltinImport:off - runs at process start, before the Effect runtime.
import * as NodeTls from "node:tls";

/**
 * Node trusts only its bundled roots and NODE_EXTRA_CA_CERTS, read once at start. A gateway behind
 * an internal CA is trusted once that CA is in the system store, as curl and browsers trust it.
 * Node caches the system store per process, so a CA installed later needs a restart.
 */
export function trustSystemCertificates(
  tls: Pick<typeof NodeTls, "getCACertificates" | "setDefaultCACertificates"> = NodeTls,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Older Electron Node lacks these; it keeps Node's defaults.
  if (typeof tls.setDefaultCACertificates !== "function") return;
  try {
    const trusted = new Set([
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("system"),
    ]);
    tls.setDefaultCACertificates([...trusted]);
    // Agents Next starts (Pi and other Node CLIs) read the system store themselves.
    env.NODE_USE_SYSTEM_CA ??= "1";
  } catch {
    // An unreadable system store leaves Node's defaults in place.
  }
}

const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

/** Whether a failed request was refused because the server's certificate isn't trusted here. */
export function isUntrustedCertificate(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && UNTRUSTED_CERTIFICATE_CODES.has(code)) return true;
    const next = current as { readonly cause?: unknown; readonly reason?: unknown };
    current = next.cause ?? next.reason;
  }
  return false;
}
