import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const keychain = new Map<string, { readonly value: string; readonly options: unknown }>();

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: vi.fn(async (key: string) => keychain.get(key)?.value ?? null),
  setItemAsync: vi.fn(async (key: string, value: string, options: unknown) => {
    keychain.set(key, { value, options });
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    keychain.delete(key);
  }),
}));

import {
  loadRelayRoute,
  markRelayRoutePaired,
  removeRelayRoute,
  saveRelayRoute,
} from "./relayKeyStore";

const LABEL = "0123456789abcdef0123456789abcdef";
const STORED = {
  route: {
    relayUrl: "https://relay.example.test",
    hostId: LABEL,
    hostKey: "A".repeat(43),
    deviceToken: "device-token",
  },
  deviceSecretKey: new Uint8Array(32).fill(7),
  pairingCode: "one-time",
};

describe("relay key store", () => {
  beforeEach(() => keychain.clear());

  it("keeps a host's relay keys in the keychain, on this device only", async () => {
    await saveRelayRoute(LABEL, STORED);
    expect(await loadRelayRoute(LABEL)).toEqual(STORED);
    expect([...keychain.values()].map((entry) => entry.options)).toEqual([
      { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
    ]);
  });

  it("drops the spent pairing code and keeps the key it paired", async () => {
    await saveRelayRoute(LABEL, STORED);
    await markRelayRoutePaired(LABEL);
    const { pairingCode: _spent, ...paired } = STORED;
    expect(await loadRelayRoute(LABEL)).toEqual(paired);
  });

  it("forgets a host's keys, and reads damaged entries as none", async () => {
    await saveRelayRoute(LABEL, STORED);
    await removeRelayRoute(LABEL);
    expect(await loadRelayRoute(LABEL)).toBeNull();
    keychain.set(`libraos.relay-route.${LABEL}`, { value: "{", options: {} });
    expect(await loadRelayRoute(LABEL)).toBeNull();
  });
});
