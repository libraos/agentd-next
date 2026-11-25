import type { LibraosGatewayAccount } from "@t3tools/contracts";

// LibraOS Cloud's device sign-in (RFC 8628, client agentd-desktop) and the Gateway key a sign-in
// token may create. Answers are read here so the service only moves bytes.

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 §3.5: each slow_down adds five seconds to the interval. */
export const SLOW_DOWN_SECONDS = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export function parseDeviceCode(body: unknown): DeviceCode | null {
  if (!isRecord(body)) return null;
  const deviceCode = text(body.device_code);
  const userCode = text(body.user_code);
  const verificationUri = text(body.verification_uri);
  if (!deviceCode || !userCode || !isHttpsUrl(verificationUri)) return null;
  const complete = text(body.verification_uri_complete);
  const expires = Number(body.expires_in);
  const interval = Number(body.interval);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: isHttpsUrl(complete) ? complete : verificationUri,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 600,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export type TokenAnswer =
  | { readonly _tag: "Token"; readonly token: string; readonly account: LibraosGatewayAccount }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown" }
  | {
      readonly _tag: "Ended";
      readonly reason: "expired" | "denied" | "failed";
      readonly message: string;
    };

/** One poll's answer. Never put the body in a message: a success carries the session token. */
export function readTokenAnswer(status: number, body: unknown): TokenAnswer {
  if (status >= 200 && status < 300 && isRecord(body)) {
    const token = text(body.access_token);
    if (token) {
      return {
        _tag: "Token",
        token,
        account: { email: text(body.email), workspace: text(body.workspace) },
      };
    }
  }
  const error = isRecord(body) ? text(body.error) : "";
  switch (error) {
    case "authorization_pending":
      return { _tag: "Pending" };
    case "slow_down":
      return { _tag: "SlowDown" };
    case "expired_token":
      return {
        _tag: "Ended",
        reason: "expired",
        message: "The sign-in code expired before it was approved.",
      };
    case "access_denied":
      return { _tag: "Ended", reason: "denied", message: "The sign-in was denied in the browser." };
  }
  return { _tag: "Ended", reason: "failed", message: cloudRefusal(status, body, "sign in") };
}

export interface GatewayKey {
  readonly id: string;
  readonly key: string;
}

export function parseGatewayKey(body: unknown): GatewayKey | null {
  if (!isRecord(body)) return null;
  const id = text(body.id);
  const key = text(body.key);
  return id && key.startsWith("lk_") ? { id, key } : null;
}

/** Cloud's own one-line message for a refusal (`message` or `error_description`), or the status. */
export function cloudRefusal(status: number, body: unknown, what: string): string {
  const said = isRecord(body) ? text(body.message) || text(body.error_description) : "";
  const line = said.split("\n")[0]?.slice(0, 300) ?? "";
  return line
    ? `LibraOS could not ${what}: ${line}`
    : `LibraOS could not ${what} (HTTP ${status}).`;
}

/** "LibraOS Next on <host>", within Cloud's 64-character key name limit. */
export function gatewayKeyName(hostname: string): string {
  const host = hostname.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (host ? `LibraOS Next on ${host}` : "LibraOS Next").slice(0, 64).trim();
}

export interface StoredAccount extends LibraosGatewayAccount {
  readonly keyId: string;
}

export function serializeStoredAccount(account: StoredAccount): string {
  return JSON.stringify({
    keyId: account.keyId,
    email: account.email,
    workspace: account.workspace,
  });
}

export function parseStoredAccount(raw: string): StoredAccount | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !text(value.keyId)) return null;
    return { keyId: text(value.keyId), email: text(value.email), workspace: text(value.workspace) };
  } catch {
    return null;
  }
}
