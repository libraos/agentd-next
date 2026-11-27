import { describe, expect, it } from "vite-plus/test";

import { keyPairFromSecretKey, NoiseError, XkHandshake } from "./noise.ts";

const hex = (value: string) =>
  Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// Noise_XK_25519_ChaChaPoly_BLAKE2s from the cacophony test vectors (vectors/cacophony.txt).
const vector = {
  prologue: "4a6f686e2047616c74",
  initStatic: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshakeHash: "899891a0f1a8db67f8bfa46b8bced371c1c25de377f20cf882fdd06fc15517fd",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944e953bb4cd3450eecab157a8ce632f74fcac39a3fcd5be08267d5923ca353d4f0",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext:
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884382521c3ea09af48bfa39627819b007e7c0e179dad4a9a7482841bae32ec8eb",
    },
    {
      payload: "462e20412e20486179656b",
      ciphertext:
        "f032de86c8d3c2099478fefb9b2e6a1fef904d3b2470949858ae9f497ff068dbb6ff7cb43fa51946bcd8a87863849aa7f0e663cd83961c752ce3be41384de8a849e4d130d9a2d717a5c7e8",
    },
    {
      payload: "4361726c204d656e676572",
      ciphertext: "cb54ca2168a55a150760c409e2157b9e57ceab823d897bff36eeab",
    },
    {
      payload: "4a65616e2d426170746973746520536179",
      ciphertext: "948e26c8a5348aec2711343de8e7c8faa7cae4b6bf51e9026eab234ed4f3e8e8fc",
    },
    {
      payload: "457567656e2042f6686d20766f6e2042617765726b",
      ciphertext: "dbf0cedc457d87e0eaa4629b7167a7e552ac5197d5436a20a1b5ba001ca21116e22669773c",
    },
  ],
};

const startVector = () => {
  const responderStatic = keyPairFromSecretKey(hex(vector.respStatic));
  const initiator = XkHandshake.initiator({
    prologue: hex(vector.prologue),
    staticKeyPair: keyPairFromSecretKey(hex(vector.initStatic)),
    ephemeralKeyPair: keyPairFromSecretKey(hex(vector.initEphemeral)),
    remoteStaticKey: responderStatic.publicKey,
  });
  const responder = XkHandshake.responder({
    prologue: hex(vector.prologue),
    staticKeyPair: responderStatic,
    ephemeralKeyPair: keyPairFromSecretKey(hex(vector.respEphemeral)),
  });
  return { initiator, responder };
};

describe("Noise XK", () => {
  it("matches the published test vector, handshake and transport", () => {
    const { initiator, responder } = startVector();
    vector.messages.forEach((message, index) => {
      const fromInitiator = index % 2 === 0;
      const [writer, reader] = fromInitiator ? [initiator, responder] : [responder, initiator];
      const payload = hex(message.payload);
      let ciphertext: Uint8Array;
      let received: Uint8Array;
      if (index < 3) {
        ciphertext = writer.writeMessage(payload);
        received = reader.readMessage(ciphertext);
      } else {
        ciphertext = writer.transport.send.encryptWithAd(new Uint8Array(0), payload);
        received = reader.transport.receive.decryptWithAd(new Uint8Array(0), ciphertext);
      }
      expect(toHex(ciphertext)).toBe(message.ciphertext);
      expect(toHex(received)).toBe(message.payload);
      if (index === 2) {
        expect(toHex(initiator.handshakeHash)).toBe(vector.handshakeHash);
        expect(toHex(responder.handshakeHash)).toBe(vector.handshakeHash);
        expect(toHex(responder.remoteStaticKey!)).toBe(
          toHex(keyPairFromSecretKey(hex(vector.initStatic)).publicKey),
        );
      }
    });
  });

  it("fails the first message when the initiator holds the wrong responder key", () => {
    const { responder } = startVector();
    const impostorKey = keyPairFromSecretKey(hex(vector.initEphemeral)).publicKey;
    const initiator = XkHandshake.initiator({
      prologue: hex(vector.prologue),
      staticKeyPair: keyPairFromSecretKey(hex(vector.initStatic)),
      remoteStaticKey: impostorKey,
    });
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError);
  });
});
