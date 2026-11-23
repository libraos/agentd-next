import { describe, expect, it } from "vite-plus/test";

import {
  AGE_IDENTITY,
  AGE_RECIPIENT,
  ageKeyPairFromIdentity,
  ageKeyPairFromSecret,
  isAgeRecipient,
} from "./ageKey";

// Throwaway keys made by filippo.io/age's GenerateX25519Identity for this test; they protect nothing.
const AGE_VECTORS = [
  {
    identity: "AGE-SECRET-KEY-10AAFF95EKNH8JEF892J06SPGESJZA6MEMP4YWS84WFR5ZLXE34VS467K9T",
    recipient: "age1q4d33m3a9720za7jflgm5shgtud2f0tzu6rq6am5tl78x67g6vqs53vjz3",
  },
  {
    identity: "AGE-SECRET-KEY-1LZMYHRJ0CJDGHTAPJZT7FZ20NFYMDTP8ZWGE4S2WMX5CLHXFFL3Q4G9SX9",
    recipient: "age1fmja4hdqye5hj2stxds2x3m68t8uzyx52rg7r0r76jf5hglzxf9sld4z29",
  },
] as const;

describe("age keys", () => {
  it("derives the same public key from a private key as age does", () => {
    for (const vector of AGE_VECTORS) {
      expect(ageKeyPairFromIdentity(vector.identity)).toEqual(vector);
      expect(ageKeyPairFromIdentity(`  ${vector.identity}\n`)).toEqual(vector);
      expect(isAgeRecipient(vector.recipient)).toBe(true);
    }
  });

  it("writes a new key in age's own text forms, and reads it back", () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 1);
    const pair = ageKeyPairFromSecret(secret);
    expect(pair.recipient).toMatch(AGE_RECIPIENT);
    expect(pair.identity).toMatch(AGE_IDENTITY);
    expect(ageKeyPairFromIdentity(pair.identity)).toEqual(pair);
    expect(ageKeyPairFromSecret(Uint8Array.from(secret).fill(9, 0, 1))).not.toEqual(pair);
  });

  it("refuses a key with a typo, the wrong kind or the wrong length", () => {
    const [vector] = AGE_VECTORS;
    const typo = `${vector.identity.slice(0, -1)}${vector.identity.endsWith("T") ? "V" : "T"}`;
    expect(ageKeyPairFromIdentity(typo)).toBeNull();
    expect(ageKeyPairFromIdentity(vector.recipient)).toBeNull();
    expect(ageKeyPairFromIdentity(vector.identity.toLowerCase())).toBeNull();
    expect(isAgeRecipient(`${vector.recipient.slice(0, -1)}q`)).toBe(false);
    expect(isAgeRecipient(vector.identity)).toBe(false);
    expect(() => ageKeyPairFromSecret(new Uint8Array(31))).toThrow();
  });
});
