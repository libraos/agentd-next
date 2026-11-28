// @effect-diagnostics nodeBuiltinImport:off - plain async helpers shared by `lnext relay`, Settings and the auth handlers.
import { isProcessAlive } from "../../serverRuntimeState.ts";
import { deleteRelayDevice } from "./relayApi.ts";
import {
  forgetRelayConnected,
  listRelayDevices,
  listRelaySessionLinks,
  loadOrCreateHostKey,
  readRelayConfig,
  readRelayHostStatus,
  readRelayLastConnected,
  removePairingCodeByHash,
  removeRelayDevice,
  removeRelaySessionLink,
  toBase64Url,
} from "./relayStore.ts";

export interface RelayOverviewDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly addedAt: string;
  readonly lastConnectedAt: string | null;
}

export interface RelayOverview {
  /** Null when this computer is not connected to a relay. */
  readonly relay: {
    readonly relayUrl: string;
    readonly hostId: string | null;
    readonly hostKey: string;
    /** Whether a running server here has its control socket to the relay open. */
    readonly online: boolean;
  } | null;
  readonly devices: ReadonlyArray<RelayOverviewDevice>;
}

/** What `lnext relay status|devices` print and Settings → Relay shows. */
export const readRelayOverview = async (stateDir: string): Promise<RelayOverview> => {
  const [config, devices, lastConnected, hostStatus] = await Promise.all([
    readRelayConfig(stateDir),
    listRelayDevices(stateDir),
    readRelayLastConnected(stateDir),
    readRelayHostStatus(stateDir),
  ]);
  return {
    relay:
      config === null
        ? null
        : {
            relayUrl: config.relayUrl,
            hostId: config.hostId,
            hostKey: toBase64Url((await loadOrCreateHostKey(stateDir)).publicKey),
            online: hostStatus?.connected === true && isProcessAlive(hostStatus.pid),
          },
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      addedAt: device.addedAt,
      lastConnectedAt: lastConnected[device.deviceId] ?? null,
    })),
  };
};

export interface RelayRevokeResult {
  /** Whether this computer held a key for the device. */
  readonly keyRemoved: boolean;
  readonly atRelay:
    | { readonly kind: "revoked" }
    | { readonly kind: "not-connected" }
    | { readonly kind: "failed"; readonly message: string };
}

/**
 * Revokes a relay device: this computer deletes its key, so the host refuses its next handshake
 * and closes an open session, and the relay drops its token. The key goes first, so a relay that
 * cannot be reached still leaves the device locked out here.
 */
export const revokeRelayDevice = async (
  stateDir: string,
  deviceId: string,
): Promise<RelayRevokeResult> => {
  const removed = await removeRelayDevice(stateDir, deviceId);
  await forgetRelayConnected(stateDir, deviceId);
  if (removed?.pairingCodeHash !== undefined) {
    for (const link of await listRelaySessionLinks(stateDir)) {
      if (link.pairingCodeHash === removed.pairingCodeHash) {
        await removeRelaySessionLink(stateDir, link.sessionId);
      }
    }
  }
  const config = await readRelayConfig(stateDir);
  if (config === null)
    return { keyRemoved: removed !== undefined, atRelay: { kind: "not-connected" } };
  try {
    await deleteRelayDevice(config, deviceId);
    return { keyRemoved: removed !== undefined, atRelay: { kind: "revoked" } };
  } catch (cause) {
    return {
      keyRemoved: removed !== undefined,
      atRelay: { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
};

const revokeLinked = async (stateDir: string, pick: (sessionId: string) => boolean) => {
  const links = (await listRelaySessionLinks(stateDir)).filter((link) => pick(link.sessionId));
  if (links.length === 0) return [];
  const hashes = new Set(links.map((link) => link.pairingCodeHash));
  const devices = (await listRelayDevices(stateDir)).filter(
    (device) => device.pairingCodeHash !== undefined && hashes.has(device.pairingCodeHash),
  );
  const results: Array<RelayRevokeResult & { readonly deviceId: string }> = [];
  for (const device of devices) {
    results.push({
      deviceId: device.deviceId,
      ...(await revokeRelayDevice(stateDir, device.deviceId)),
    });
  }
  // A code not used yet must not pair a key for the revoked session's link later.
  for (const link of links) {
    await removePairingCodeByHash(stateDir, link.pairingCodeHash);
    await removeRelaySessionLink(stateDir, link.sessionId);
  }
  return results;
};

/** Revokes the relay key each of these sessions paired, so a revoked phone cannot come back through the relay. */
export const revokeRelayKeysOfSessions = (stateDir: string, sessionIds: ReadonlyArray<string>) => {
  const revoked = new Set(sessionIds);
  return revokeLinked(stateDir, (sessionId) => revoked.has(sessionId));
};

/**
 * For "revoke other clients": the relay keys every other session paired go. Pairing links not used
 * yet stay, as they do for the sessions. A key paired before sessions were linked stays too: it
 * may be the caller's own.
 */
export const revokeRelayKeysExceptSession = (stateDir: string, keptSessionId: string) =>
  revokeLinked(stateDir, (sessionId) => sessionId !== keptSessionId);
