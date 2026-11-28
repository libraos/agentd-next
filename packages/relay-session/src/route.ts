/** What a device needs to reach a host through a relay; it travels in the pairing link's fragment. */
export interface RelayRoute {
  /** The relay's HTTPS base URL. */
  readonly relayUrl: string;
  readonly hostId: string;
  /** The host's static X25519 key, base64url. */
  readonly hostKey: string;
  readonly deviceToken: string;
}

const FRAGMENT_KEYS = {
  relayUrl: "relay",
  hostId: "host",
  hostKey: "hk",
  deviceToken: "dt",
} as const satisfies Record<keyof RelayRoute, string>;

/** Adds the route to the link's fragment, keeping what is there, so it never reaches a server log. */
export const setRelayRouteOnUrl = (pairingUrl: string, route: RelayRoute): string => {
  const url = new URL(pairingUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  for (const [field, key] of Object.entries(FRAGMENT_KEYS)) {
    fragment.set(key, route[field as keyof RelayRoute]);
  }
  url.hash = fragment.toString();
  return url.toString();
};

/** The WebSocket subprotocol of every connection to the relay. */
export const RELAY_SUBPROTOCOL = "libraos-relay.1";

/** The route in a pairing link's fragment, or null when the link carries none or only part of it. */
export const readRelayRouteFromUrl = (pairingUrl: string): RelayRoute | null => {
  let fragment: URLSearchParams;
  try {
    fragment = new URLSearchParams(new URL(pairingUrl.trim()).hash.slice(1));
  } catch {
    return null;
  }
  const relayUrl = fragment.get(FRAGMENT_KEYS.relayUrl) ?? "";
  const hostId = fragment.get(FRAGMENT_KEYS.hostId) ?? "";
  const hostKey = fragment.get(FRAGMENT_KEYS.hostKey) ?? "";
  const deviceToken = fragment.get(FRAGMENT_KEYS.deviceToken) ?? "";
  if (relayHostLabel(hostId) === null || hostKey === "" || deviceToken === "") return null;
  try {
    // The device token travels on every connection, so plain http only on the same machine.
    const url = new URL(relayUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  } catch {
    return null;
  }
  return { relayUrl, hostId, hostKey, deviceToken };
};

// Reserved by RFC 2606, so a request that escapes the relay transport fails instead of reaching
// a real host.
const RELAY_ORIGIN_SUFFIX = ".relay.invalid";
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host id as a DNS label, or null when it cannot be one; such a host is reached only directly. */
export const relayHostLabel = (hostId: string): string | null => {
  const label = hostId.toLowerCase();
  return HOST_LABEL.test(label) ? label : null;
};

/**
 * The address a client uses for a host it reaches through the relay. Nothing resolves it: the
 * device's relay transport carries every request to it inside the host's encrypted session.
 */
export const relayBaseUrl = (route: Pick<RelayRoute, "hostId">): string =>
  `https://${relayOriginHost(route.hostId)}/`;

/** The host name of relayBaseUrl, which the host also presents to its server as the request's host. */
export const relayOriginHost = (hostId: string): string => {
  const label = relayHostLabel(hostId);
  if (label === null) throw new Error("This relay host id cannot be an address.");
  return `${label}${RELAY_ORIGIN_SUFFIX}`;
};

/** The host label of an address made by relayBaseUrl (http, https, ws or wss), or null for any other. */
export const relayHostLabelOfUrl = (url: string): string | null => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname.endsWith(RELAY_ORIGIN_SUFFIX)) return null;
  const label = hostname.slice(0, -RELAY_ORIGIN_SUFFIX.length);
  return HOST_LABEL.test(label) ? label : null;
};

/** The WebSocket URL a device opens to reach the host through the relay. */
export const relayDeviceEndpoint = (route: Pick<RelayRoute, "relayUrl" | "hostId">): string => {
  const url = new URL(route.relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/relay/v1/device`;
  url.search = new URLSearchParams([["host", route.hostId]]).toString();
  url.hash = "";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};
