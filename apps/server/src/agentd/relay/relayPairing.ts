import { mintRelayDeviceToken } from "./relayApi.ts";
import {
  loadOrCreateHostKey,
  readRelayConfig,
  recordPairingCode,
  toBase64Url,
} from "./relayStore.ts";

export interface RelayPairing {
  readonly pairingUrl: string;
  readonly viaRelay: boolean;
  /** Why the relay is not in the link, when the host has one but could not add it. */
  readonly note?: string;
}

/**
 * Adds the relay route to a pairing link when this host is connected to a relay: the relay's URL,
 * host id, host key and a fresh device token go in the fragment, which never reaches a server
 * log. The link's one-time token doubles as the relay pairing code.
 */
export const addRelayToPairingUrl = async (input: {
  readonly stateDir: string;
  readonly pairingUrl: string;
  readonly credential: string;
  readonly expiresAt: number;
  readonly label: string;
  readonly now: number;
}): Promise<RelayPairing> => {
  const direct = (note?: string): RelayPairing =>
    note === undefined
      ? { pairingUrl: input.pairingUrl, viaRelay: false }
      : { pairingUrl: input.pairingUrl, viaRelay: false, note };
  try {
    return await withRelay(input, direct);
  } catch (cause) {
    return direct(
      `This link works only directly: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const withRelay = async (
  input: Parameters<typeof addRelayToPairingUrl>[0],
  direct: (note?: string) => RelayPairing,
): Promise<RelayPairing> => {
  const config = await readRelayConfig(input.stateDir);
  if (config === null) return direct();
  if (config.hostId === null) {
    return direct(
      "The relay has not told this computer its host id yet, so this link works only directly.",
    );
  }
  const minted = await mintRelayDeviceToken(config, input.label);
  const hostKey = await loadOrCreateHostKey(input.stateDir);
  await recordPairingCode(
    input.stateDir,
    input.credential,
    { deviceId: minted.deviceId, label: input.label },
    { now: input.now, expiresAt: input.expiresAt },
  );
  const url = new URL(input.pairingUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("relay", config.relayUrl);
  fragment.set("host", config.hostId);
  fragment.set("hk", toBase64Url(hostKey.publicKey));
  fragment.set("dt", minted.deviceToken);
  url.hash = fragment.toString();
  return { pairingUrl: url.toString(), viaRelay: true };
};
