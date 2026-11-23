import { x25519 } from "@noble/curves/ed25519";

/**
 * age X25519 keys (https://age-encryption.org/v1) as text: the public key `age1...` that a
 * computer encrypts its agentd backup to, and the private key `AGE-SECRET-KEY-1...` that only this
 * device holds and that `agentd backup restore --identity-file -` reads. Both are bech32 (BIP 173,
 * not bech32m) of the 32 key bytes, with no length limit, as age itself writes them.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;
const RECIPIENT_HRP = "age";
const IDENTITY_HRP = "age-secret-key-";

export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
export const AGE_IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

export interface AgeKeyPair {
  readonly recipient: string;
  readonly identity: string;
}

function polymod(values: ReadonlyArray<number>): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = (((check & 0x1ffffff) << 5) ^ value) >>> 0;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) check = (check ^ GENERATOR[bit]!) >>> 0;
    }
  }
  return check;
}

function expandHrp(hrp: string): Array<number> {
  const codes = Array.from(hrp, (character) => character.charCodeAt(0));
  return [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)];
}

function convertBits(
  data: ReadonlyArray<number>,
  from: number,
  to: number,
  pad: boolean,
): Array<number> | null {
  let accumulator = 0;
  let bits = 0;
  const out: Array<number> = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >>> bits) & max);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((accumulator << (to - bits)) & max);
  } else if (bits >= from || ((accumulator << (to - bits)) & max) !== 0) {
    return null;
  }
  return out;
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(Array.from(bytes), 8, 5, true)!;
  const mod = polymod([...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (mod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => CHARSET[value]).join("")}`;
}

function bech32Decode(text: string, hrp: string): Uint8Array | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const lower = text.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (lower.slice(0, separator) !== hrp || lower.length - separator - 1 < 6) return null;
  const data: Array<number> = [];
  for (const character of lower.slice(separator + 1)) {
    const value = CHARSET.indexOf(character);
    if (value < 0) return null;
    data.push(value);
  }
  if (polymod([...expandHrp(hrp), ...data]) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes === null ? null : Uint8Array.from(bytes);
}

/** The key pair for a 32-byte secret; the caller supplies it from a secure random source. */
export function ageKeyPairFromSecret(secret: Uint8Array): AgeKeyPair {
  if (secret.length !== 32) throw new Error("An age X25519 key is 32 bytes.");
  return {
    recipient: bech32Encode(RECIPIENT_HRP, x25519.getPublicKey(secret)),
    identity: bech32Encode(IDENTITY_HRP, secret).toUpperCase(),
  };
}

/** The key pair for a private key as age writes it, or null when the text is not one. */
export function ageKeyPairFromIdentity(identity: string): AgeKeyPair | null {
  const trimmed = identity.trim();
  if (!AGE_IDENTITY.test(trimmed)) return null;
  const secret = bech32Decode(trimmed, IDENTITY_HRP);
  return secret === null || secret.length !== 32 ? null : ageKeyPairFromSecret(secret);
}

/** Whether `recipient` is a well-formed age public key, checksum included. */
export function isAgeRecipient(recipient: string): boolean {
  if (!AGE_RECIPIENT.test(recipient)) return false;
  const key = bech32Decode(recipient, RECIPIENT_HRP);
  return key !== null && key.length === 32;
}
