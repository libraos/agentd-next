import { describe, expect, it } from "vite-plus/test";

import { encodeText } from "./frames.ts";
import { generateKeyPair, type KeyPair } from "./noise.ts";
import { type HandshakeClaims, SecureSession, SessionCloseCode } from "./session.ts";

const HOST_ID = "host-1";

interface Pair {
  readonly device: SecureSession;
  readonly host: SecureSession;
  readonly hostReceived: Array<string>;
  readonly hostClose: Array<number>;
  readonly claims: Array<HandshakeClaims>;
  /** Delivers queued messages until neither side has more. */
  readonly pump: () => Promise<void>;
  readonly toHost: Array<Uint8Array>;
}

const connect = (input: {
  readonly hostKeys: KeyPair;
  readonly hostKeyOnDevice: Uint8Array;
  readonly allow: boolean;
  readonly pairingCode?: string;
}): Pair => {
  const toHost: Array<Uint8Array> = [];
  const toDevice: Array<Uint8Array> = [];
  const hostReceived: Array<string> = [];
  const hostClose: Array<number> = [];
  const claims: Array<HandshakeClaims> = [];
  const host = SecureSession.responder({
    transport: { send: (data) => toDevice.push(data), close: () => {} },
    hostId: HOST_ID,
    staticKeyPair: input.hostKeys,
    authorize: async (_key, presented) => {
      claims.push(presented);
      return input.allow;
    },
    onMessage: (plaintext) => hostReceived.push(new TextDecoder().decode(plaintext)),
    onClose: (code) => hostClose.push(code),
  });
  const device = SecureSession.initiator({
    transport: { send: (data) => toHost.push(data), close: () => {} },
    hostId: HOST_ID,
    staticKeyPair: generateKeyPair(),
    hostStaticKey: input.hostKeyOnDevice,
    ...(input.pairingCode === undefined ? {} : { pairingCode: input.pairingCode }),
  });
  const pump = async () => {
    while (toHost.length > 0 || toDevice.length > 0) {
      for (const message of toHost.splice(0)) host.receive(message);
      await host.settled();
      for (const message of toDevice.splice(0)) device.receive(message);
      await device.settled();
    }
  };
  return { device, host, hostReceived, hostClose, claims, pump, toHost };
};

describe("SecureSession", () => {
  it("opens both ends and carries the pairing code in the third message", async () => {
    const hostKeys = generateKeyPair();
    const pair = connect({
      hostKeys,
      hostKeyOnDevice: hostKeys.publicKey,
      allow: true,
      pairingCode: "code-1",
    });
    await pair.pump();
    expect(pair.device.isOpen).toBe(true);
    expect(pair.host.isOpen).toBe(true);
    expect(pair.claims).toEqual([{ pairing: "code-1" }]);
    pair.device.send(encodeText("hello"));
    await pair.pump();
    expect(pair.hostReceived).toEqual(["hello"]);
  });

  it("fails the handshake when the device holds the wrong host key", async () => {
    const pair = connect({
      hostKeys: generateKeyPair(),
      hostKeyOnDevice: generateKeyPair().publicKey,
      allow: true,
    });
    await pair.pump();
    expect(pair.host.isOpen).toBe(false);
    expect(pair.device.isOpen).toBe(false);
    expect(pair.hostClose).toEqual([SessionCloseCode.PROTOCOL_ERROR]);
    expect(pair.claims).toEqual([]);
  });

  it("closes the session on a tampered transport message", async () => {
    const hostKeys = generateKeyPair();
    const pair = connect({ hostKeys, hostKeyOnDevice: hostKeys.publicKey, allow: true });
    await pair.pump();
    pair.device.send(encodeText("first"));
    pair.device.send(encodeText("second"));
    pair.toHost[0]![3]! ^= 0x01;
    await pair.pump();
    expect(pair.hostReceived).toEqual([]);
    expect(pair.host.isClosed).toBe(true);
    expect(pair.hostClose).toEqual([SessionCloseCode.PROTOCOL_ERROR]);
  });

  it("delivers nothing from a device the host refuses, even what it sent right after its handshake", async () => {
    const hostKeys = generateKeyPair();
    const pair = connect({ hostKeys, hostKeyOnDevice: hostKeys.publicKey, allow: false });
    // Deliver the first two handshake messages, then send data with the third.
    pair.host.receive(pair.toHost.shift()!);
    await pair.host.settled();
    await pair.pump();
    pair.device.send(encodeText("GET /"));
    await pair.pump();
    expect(pair.hostReceived).toEqual([]);
    expect(pair.hostClose).toEqual([SessionCloseCode.NOT_AUTHORIZED]);
  });
});
