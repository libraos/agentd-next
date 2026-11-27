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
