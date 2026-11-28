import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { StoredRelayRoute } from "@t3tools/relay-session/deviceRouter";
import type { RelayRoute } from "@t3tools/relay-session/route";
import * as SecureStore from "expo-secure-store";

// Keychain only, readable while unlocked, never restored to another device: the secret key is this
// phone's identity at the host, and the device token is its pass at the relay.
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const keyFor = (hostLabel: string) => `libraos.relay-route.${hostLabel}`;

interface StoredJson {
  readonly route: RelayRoute;
  readonly deviceSecretKey: string;
  readonly pairingCode?: string;
}

const isRoute = (value: unknown): value is RelayRoute => {
  if (typeof value !== "object" || value === null) return false;
  const route = value as Record<string, unknown>;
  return ["relayUrl", "hostId", "hostKey", "deviceToken"].every(
    (field) => typeof route[field] === "string",
  );
};

export const decodeStoredRelayRoute = (raw: string): StoredRelayRoute | null => {
  try {
    const value = JSON.parse(raw) as Partial<StoredJson>;
    if (!isRoute(value.route) || typeof value.deviceSecretKey !== "string") return null;
    const deviceSecretKey = hexToBytes(value.deviceSecretKey);
    if (deviceSecretKey.length !== 32) return null;
    return {
      route: value.route,
      deviceSecretKey,
      ...(typeof value.pairingCode === "string" ? { pairingCode: value.pairingCode } : {}),
    };
  } catch {
    return null;
  }
};

export const encodeStoredRelayRoute = (stored: StoredRelayRoute): string =>
  JSON.stringify({
    route: stored.route,
    deviceSecretKey: bytesToHex(stored.deviceSecretKey),
    ...(stored.pairingCode === undefined ? {} : { pairingCode: stored.pairingCode }),
  } satisfies StoredJson);

export const loadRelayRoute = async (hostLabel: string): Promise<StoredRelayRoute | null> => {
  const raw = await SecureStore.getItemAsync(keyFor(hostLabel), KEYCHAIN);
  return raw === null ? null : decodeStoredRelayRoute(raw);
};

export const saveRelayRoute = (hostLabel: string, stored: StoredRelayRoute): Promise<void> =>
  SecureStore.setItemAsync(keyFor(hostLabel), encodeStoredRelayRoute(stored), KEYCHAIN);

/** Drops the spent pairing code, keeping the key it paired. */
export const markRelayRoutePaired = async (hostLabel: string): Promise<void> => {
  const stored = await loadRelayRoute(hostLabel);
  if (stored === null || stored.pairingCode === undefined) return;
  await saveRelayRoute(hostLabel, { route: stored.route, deviceSecretKey: stored.deviceSecretKey });
};

export const removeRelayRoute = (hostLabel: string): Promise<void> =>
  SecureStore.deleteItemAsync(keyFor(hostLabel), KEYCHAIN);
