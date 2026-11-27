// @effect-diagnostics nodeBuiltinImport:off - shared by the CLI and the relay host's socket callbacks, outside Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { generateKeyPair, type KeyPair, keyPairFromSecretKey } from "@t3tools/relay-session/noise";

// Everything the relay host keeps lives in <stateDir>/relay, readable only by its user. Windows
// ignores the modes; the state directory under the user's profile is already private to them.
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export interface RelayConfig {
  readonly relayUrl: string;
  readonly token: string;
  /** Learned from the relay's hello, or given with --host-id. */
  readonly hostId: string | null;
}

export interface RelayDevice {
  readonly deviceId: string;
  /** The device's static X25519 key, base64url. */
  readonly publicKey: string;
  readonly label: string;
  readonly addedAt: string;
}

const relayDir = (stateDir: string) => NodePath.join(stateDir, "relay");
const configPath = (stateDir: string) => NodePath.join(relayDir(stateDir), "relay.json");
const hostKeyPath = (stateDir: string) => NodePath.join(relayDir(stateDir), "host-key");
const devicesPath = (stateDir: string) => NodePath.join(relayDir(stateDir), "devices.json");
const pairingDir = (stateDir: string) => NodePath.join(relayDir(stateDir), "pairing");

export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromBase64Url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";

const ensureDir = (dir: string) => NodeFSP.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });

/** Replaces the file whole, so a reader never sees half of it. */
const writePrivateFile = async (path: string, content: string) => {
  await ensureDir(NodePath.dirname(path));
  const temp = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temp, content, { mode: PRIVATE_FILE, flag: "wx" });
    await NodeFSP.rename(temp, path);
  } catch (cause) {
    await NodeFSP.rm(temp, { force: true });
    throw cause;
  }
};

const readText = async (path: string): Promise<string | null> => {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
};

export const readRelayConfig = async (stateDir: string): Promise<RelayConfig | null> => {
  const text = await readText(configPath(stateDir));
  if (text === null) return null;
  const value = JSON.parse(text) as Partial<RelayConfig>;
  if (typeof value.relayUrl !== "string" || typeof value.token !== "string") return null;
  return {
    relayUrl: value.relayUrl,
    token: value.token,
    hostId: typeof value.hostId === "string" && value.hostId.length > 0 ? value.hostId : null,
  };
};

export const writeRelayConfig = (stateDir: string, config: RelayConfig) =>
  writePrivateFile(configPath(stateDir), `${JSON.stringify(config, null, 2)}\n`);

export const removeRelayConfig = (stateDir: string) =>
  NodeFSP.rm(configPath(stateDir), { force: true });

/** The host's static key, made on first use. */
export const loadOrCreateHostKey = async (stateDir: string): Promise<KeyPair> => {
  const path = hostKeyPath(stateDir);
  const existing = await readText(path);
  if (existing !== null) return keyPairFromSecretKey(fromBase64Url(existing.trim()));
  const created = generateKeyPair();
  await ensureDir(relayDir(stateDir));
  try {
    await NodeFSP.writeFile(path, `${toBase64Url(created.secretKey)}\n`, {
      mode: PRIVATE_FILE,
      flag: "wx",
    });
    return created;
  } catch (cause) {
    // Another process made it first; theirs wins.
    if ((cause as { code?: unknown }).code === "EEXIST") return loadOrCreateHostKey(stateDir);
    throw cause;
  }
};

export const listRelayDevices = async (stateDir: string): Promise<ReadonlyArray<RelayDevice>> => {
  const text = await readText(devicesPath(stateDir));
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) ? (value as ReadonlyArray<RelayDevice>) : [];
};

const writeRelayDevices = (stateDir: string, devices: ReadonlyArray<RelayDevice>) =>
  writePrivateFile(devicesPath(stateDir), `${JSON.stringify(devices, null, 2)}\n`);

export const addRelayDevice = async (stateDir: string, device: RelayDevice) => {
  const devices = await listRelayDevices(stateDir);
  await writeRelayDevices(stateDir, [
    ...devices.filter(
      (entry) => entry.deviceId !== device.deviceId && entry.publicKey !== device.publicKey,
    ),
    device,
  ]);
};

/** Deletes the device's key; returns the removed entry, if there was one. */
export const removeRelayDevice = async (
  stateDir: string,
  deviceId: string,
): Promise<RelayDevice | undefined> => {
  const devices = await listRelayDevices(stateDir);
  const removed = devices.find((entry) => entry.deviceId === deviceId);
  if (removed !== undefined) {
    await writeRelayDevices(
      stateDir,
      devices.filter((entry) => entry !== removed),
    );
  }
  return removed;
};

// Codes are stored by hash, one file each, so taking one is a single atomic unlink.
const pairingCodePath = (stateDir: string, code: string) =>
  NodePath.join(
    pairingDir(stateDir),
    NodeCrypto.createHash("sha256").update(code, "utf8").digest("hex"),
  );

export interface PairingGrant {
  /** The relay device the code was minted with; only that device may use it. */
  readonly deviceId: string;
  readonly label: string;
}

const readExpiry = (content: string) => {
  try {
    const value = JSON.parse(content) as { expiresAt?: unknown };
    return typeof value.expiresAt === "number" ? value.expiresAt : 0;
  } catch {
    return 0;
  }
};

/** Lets `grant.deviceId` in with `code` once, until `expiresAt` and at most PAIRING_CODE_TTL_MS from now. */
export const recordPairingCode = async (
  stateDir: string,
  code: string,
  grant: PairingGrant,
  options: { readonly now: number; readonly expiresAt?: number },
) => {
  const expiresAt = Math.min(options.expiresAt ?? Infinity, options.now + PAIRING_CODE_TTL_MS);
  await ensureDir(pairingDir(stateDir));
  await prunePairingCodes(stateDir, options.now);
  await NodeFSP.writeFile(
    pairingCodePath(stateDir, code),
    JSON.stringify({ expiresAt, deviceId: grant.deviceId, label: grant.label }),
    { mode: PRIVATE_FILE, flag: "wx" },
  );
};

/** The grant once for a recorded, unexpired code of this device; null for one used, expired, another's or never issued. */
export const consumePairingCode = async (
  stateDir: string,
  code: string,
  deviceId: string,
  now: number,
): Promise<PairingGrant | null> => {
  if (code.length === 0) return null;
  const path = pairingCodePath(stateDir, code);
  const content = await readText(path);
  if (content === null) return null;
  try {
    await NodeFSP.unlink(path);
  } catch (cause) {
    // Taken by a concurrent session.
    if (isMissing(cause)) return null;
    throw cause;
  }
  const value = JSON.parse(content) as Partial<PairingGrant> & { expiresAt?: unknown };
  if (readExpiry(content) <= now || value.deviceId !== deviceId) return null;
  return { deviceId, label: typeof value.label === "string" ? value.label : "" };
};

const prunePairingCodes = async (stateDir: string, now: number) => {
  let names: ReadonlyArray<string>;
  try {
    names = await NodeFSP.readdir(pairingDir(stateDir));
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  await Promise.all(
    names.map(async (name) => {
      const path = NodePath.join(pairingDir(stateDir), name);
      const content = await readText(path);
      if (content !== null && readExpiry(content) <= now) await NodeFSP.rm(path, { force: true });
    }),
  );
};
