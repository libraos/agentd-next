// @effect-diagnostics extendsNativeError:off globalFetch:off - plain async helpers, shared with the relay host's socket code.
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

import type { RelayConfig } from "./relayStore.ts";

export const RELAY_SUBPROTOCOL = "libraos-relay.1";
const API_TIMEOUT_MS = 15_000;

class RelayApiError extends Error {
  override readonly name: string = "RelayApiError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The relay's base URL: HTTPS, or plain HTTP only on this machine. The token travels on
 * every connection, so it must not cross a network in the clear.
 */
export const parseRelayUrl = (value: string): URL | string => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return `Not a URL: ${value}`;
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""))) {
    return url;
  }
  return "The relay URL must start with https:// (http:// works only for a relay on this machine).";
};

/** Joins `path` under the relay's base path, as http(s) or ws(s). */
export const relayEndpoint = (relayUrl: string, path: string, websocket = false): string => {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  if (websocket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const relayAuthHeaders = (config: Pick<RelayConfig, "token">) => ({
  authorization: `Bearer ${config.token}`,
});

const call = async (config: RelayConfig, method: string, path: string, body?: unknown) => {
  let response: Response;
  try {
    response = await fetch(relayEndpoint(config.relayUrl, path), {
      method,
      headers: {
        ...relayAuthHeaders(config),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RelayApiError(
      `Could not reach the relay at ${config.relayUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return response;
};

/** Mints a device token for the pairing link, tied to this host. */
export const mintRelayDeviceToken = async (
  config: RelayConfig,
  label: string,
): Promise<{ readonly deviceId: string; readonly deviceToken: string }> => {
  const response = await call(config, "POST", "/relay/v1/devices", { label });
  if (!response.ok) {
    throw new RelayApiError(
      `The relay refused a device token (HTTP ${String(response.status)}).`,
      response.status,
    );
  }
  const value = (await response.json()) as { deviceId?: unknown; deviceToken?: unknown };
  if (typeof value.deviceId !== "string" || typeof value.deviceToken !== "string") {
    throw new RelayApiError("The relay's device token reply is missing deviceId or deviceToken.");
  }
  return { deviceId: value.deviceId, deviceToken: value.deviceToken };
};

/** Revokes a device at the relay, which closes its connections. A device it no longer knows is fine. */
export const deleteRelayDevice = async (config: RelayConfig, deviceId: string): Promise<void> => {
  const response = await call(
    config,
    "DELETE",
    `/relay/v1/devices/${encodeURIComponent(deviceId)}`,
  );
  if (!response.ok && response.status !== 404) {
    throw new RelayApiError(
      `The relay did not revoke the device (HTTP ${String(response.status)}).`,
      response.status,
    );
  }
};
