// @effect-diagnostics nodeBuiltinImport:off - a scratch state directory and the test relay on real sockets.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { generateKeyPair, type KeyPair } from "@t3tools/relay-session/noise";
import { SessionCloseCode } from "@t3tools/relay-session/session";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readRelayOverview,
  revokeRelayDevice,
  revokeRelayKeysExceptSession,
  revokeRelayKeysOfSessions,
} from "./relayDevices.ts";
import { startRelayHost, type RelayHost } from "./relayHost.ts";
import {
  linkRelaySession,
  listRelayDevices,
  loadOrCreateHostKey,
  recordPairingCode,
  removePairingCodesOfLink,
  writeRelayConfig,
} from "./relayStore.ts";
import { connectDevice, startTestRelay, TEST_HOST_ID, TEST_HOST_TOKEN } from "./testRelay.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const EPOCH_ISO = "2026-01-01T00:00:00.000Z";

describe("relay devices", () => {
  let stateDir: string;
  let relay: Awaited<ReturnType<typeof startTestRelay>>;
  let host: RelayHost | undefined;
  let hostKey: KeyPair;

  const startHost = async () => {
    const connected = relay.nextControl();
    host = startRelayHost({
      stateDir,
      // Nothing is forwarded in these tests; the multiplexer's ping is answered by the host itself.
      target: { host: "127.0.0.1", port: 9 },
      backoff: { initialMs: 10, maxMs: 50 },
      pollMs: 50,
      now: () => EPOCH,
    });
    await connected;
  };

  /** Pairs a phone through the relay with `code`, as a Settings link's token does. */
  const pairPhone = async (code: string, label = "phone") => {
    const minted = relay.mintDevice();
    await recordPairingCode(
      stateDir,
      code,
      { deviceId: minted.deviceId, label, pairingLinkId: `link-${code}` },
      { now: EPOCH },
    );
    const deviceKeys = generateKeyPair();
    const device = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys,
      hostKey: hostKey.publicKey,
      pairingCode: code,
    });
    await device.mux.ping();
    return { ...minted, deviceKeys, device };
  };

  /** A reconnect with the device's own key, through a relay that still lets its token in. */
  const reconnect = (deviceId: string, deviceKeys: KeyPair) =>
    connectDevice({
      relayUrl: relay.url,
      deviceToken: relay.mintDevice(deviceId).deviceToken,
      deviceKeys,
      hostKey: hostKey.publicKey,
    });

  beforeEach(async () => {
    stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-devices-"));
    relay = await startTestRelay();
    await writeRelayConfig(stateDir, {
      relayUrl: relay.url,
      token: TEST_HOST_TOKEN,
      hostId: TEST_HOST_ID,
    });
    hostKey = await loadOrCreateHostKey(stateDir);
  });

  afterEach(async () => {
    await host?.stop();
    host = undefined;
    await relay.close();
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });

  it("shows the relay, whether the server is connected, and when each device last connected", async () => {
    expect(await readRelayOverview(stateDir)).toMatchObject({
      relay: { relayUrl: relay.url, hostId: TEST_HOST_ID, online: false },
      devices: [],
    });
    await startHost();
    const phone = await pairPhone("code-1", "My phone");
    const overview = await readRelayOverview(stateDir);
    expect(overview.relay?.online).toBe(true);
    expect(overview.devices).toEqual([
      {
        deviceId: phone.deviceId,
        label: "My phone",
        addedAt: EPOCH_ISO,
        lastConnectedAt: EPOCH_ISO,
      },
    ]);

    await host?.stop();
    host = undefined;
    expect((await readRelayOverview(stateDir)).relay?.online).toBe(false);
  });

  it("revoking a device closes its session, revokes it at the relay and refuses it next time", async () => {
    await startHost();
    const phone = await pairPhone("code-2");
    const result = await revokeRelayDevice(stateDir, phone.deviceId);
    expect(result).toEqual({ keyRemoved: true, atRelay: { kind: "revoked" } });
    expect(relay.revoked).toEqual([phone.deviceId]);
    expect(await phone.device.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
    expect((await readRelayOverview(stateDir)).devices).toEqual([]);

    // Its old token is gone at the relay…
    await expect(
      connectDevice({
        relayUrl: relay.url,
        deviceToken: phone.deviceToken,
        deviceKeys: phone.deviceKeys,
        hostKey: hostKey.publicKey,
      }),
    ).rejects.toThrow("closed 4401");
    // …and a relay that let it in anyway would still meet a host that no longer knows its key.
    const retried = await reconnect(phone.deviceId, phone.deviceKeys);
    expect(await retried.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
  });

  it("revoking a session revokes the relay key its pairing code paired, used or not yet", async () => {
    await startHost();
    // Signed in through the relay first, then traded the code for a session.
    const phone = await pairPhone("code-3");
    expect(await linkRelaySession(stateDir, "code-3", "session-phone")).toBe(true);
    const other = await pairPhone("code-4", "tablet");
    expect(await linkRelaySession(stateDir, "code-4", "session-tablet")).toBe(true);
    // Traded the code first; it has not been through the relay yet.
    await recordPairingCode(
      stateDir,
      "code-5",
      { deviceId: relay.mintDevice().deviceId, label: "later" },
      { now: EPOCH },
    );
    expect(await linkRelaySession(stateDir, "code-5", "session-later")).toBe(true);
    // A session made with no relay code links to nothing.
    expect(await linkRelaySession(stateDir, "plain-token", "session-plain")).toBe(false);

    const revoked = await revokeRelayKeysOfSessions(stateDir, ["session-phone", "session-later"]);
    expect(revoked.map((entry) => entry.deviceId)).toEqual([phone.deviceId]);
    expect(await phone.device.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
    expect(await (await reconnect(phone.deviceId, phone.deviceKeys)).closed).toBe(
      SessionCloseCode.NOT_AUTHORIZED,
    );
    expect((await listRelayDevices(stateDir)).map((device) => device.deviceId)).toEqual([
      other.deviceId,
    ]);
    await other.device.mux.ping();

    // The unused code of the revoked session can no longer pair a key.
    const late = relay.mintDevice();
    const attempt = await connectDevice({
      relayUrl: relay.url,
      deviceToken: late.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-5",
    });
    expect(await attempt.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
  });

  it("revoking the other sessions keeps the caller's own relay key", async () => {
    await startHost();
    const mine = await pairPhone("code-6", "mine");
    await linkRelaySession(stateDir, "code-6", "session-mine");
    const theirs = await pairPhone("code-7", "theirs");
    await linkRelaySession(stateDir, "code-7", "session-theirs");

    await revokeRelayKeysExceptSession(stateDir, "session-mine");
    expect(await theirs.device.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
    expect((await listRelayDevices(stateDir)).map((device) => device.label)).toEqual(["mine"]);
    await mine.device.mux.ping();
  });

  it("revoking a pairing link drops its relay code", async () => {
    await startHost();
    const minted = relay.mintDevice();
    await recordPairingCode(
      stateDir,
      "code-8",
      { deviceId: minted.deviceId, label: "phone", pairingLinkId: "link-8" },
      { now: EPOCH },
    );
    expect(await removePairingCodesOfLink(stateDir, "link-8")).toBe(1);
    const attempt = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-8",
    });
    expect(await attempt.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
  });
});
