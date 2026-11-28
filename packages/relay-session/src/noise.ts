// @effect-diagnostics extendsNativeError:off - plain errors keep this package free of Effect for React Native.
// Noise_XK_25519_ChaChaPoly_BLAKE2s (Noise revision 34). Pure JavaScript, so it runs on Node and React Native.
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { blake2s } from "@noble/hashes/blake2s";
import { hmac } from "@noble/hashes/hmac";

import { getTransportNonceStart } from "./nonceSeam.ts";

export const NOISE_PROTOCOL_NAME = "Noise_XK_25519_ChaChaPoly_BLAKE2s";
export const KEY_LENGTH = 32;
export const TAG_LENGTH = 16;
/** The largest Noise message, ciphertext and tag included. */
export const MAX_NOISE_MESSAGE = 65_535;
/** The largest plaintext one transport message carries. */
export const MAX_TRANSPORT_PLAINTEXT = MAX_NOISE_MESSAGE - TAG_LENGTH;
/** A session closes before a cipher's nonce reaches this, and the device reconnects. */
export const NONCE_LIMIT = 2 ** 31;

export class NoiseError extends Error {
  override readonly name: string = "NoiseError";
}

export class NonceLimitError extends NoiseError {
  override readonly name: string = "NonceLimitError";
}

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export const generateKeyPair = (): KeyPair => keyPairFromSecretKey(x25519.utils.randomPrivateKey());

export const keyPairFromSecretKey = (secretKey: Uint8Array): KeyPair => {
  if (secretKey.length !== KEY_LENGTH) throw new NoiseError("An X25519 secret key is 32 bytes.");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

const dh = (keyPair: KeyPair, publicKey: Uint8Array): Uint8Array => {
  try {
    return x25519.getSharedSecret(keyPair.secretKey, publicKey);
  } catch (cause) {
    throw new NoiseError("Invalid X25519 public key.", { cause });
  }
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const hkdf = (chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] => {
  const tempKey = hmac(blake2s, chainingKey, input);
  const first = hmac(blake2s, tempKey, Uint8Array.of(1));
  const second = hmac(blake2s, tempKey, concat(first, Uint8Array.of(2)));
  return [first, second];
};

let setNonce: (cipher: CipherState, nonce: number) => void;

/** One direction of a Noise session: a key and a counting nonce. */
export class CipherState {
  #key: Uint8Array | undefined;
  #nonce = 0;

  static {
    setNonce = (cipher, nonce) => {
      cipher.#nonce = nonce;
    };
  }

  constructor(key?: Uint8Array) {
    this.#key = key;
  }

  get hasKey(): boolean {
    return this.#key !== undefined;
  }

  get nonce(): number {
    return this.#nonce;
  }

  #nextNonce(): Uint8Array {
    if (this.#nonce >= NONCE_LIMIT) throw new NonceLimitError("Nonce limit reached.");
    // 32 zero bits, then the counter as 64-bit little-endian.
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(4, this.#nonce, true);
    this.#nonce += 1;
    return nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return plaintext;
    return chacha20poly1305(this.#key, this.#nextNonce(), ad).encrypt(plaintext);
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return ciphertext;
    const key = this.#key;
    const nonceValue = this.#nonce;
    const nonce = this.#nextNonce();
    try {
      return chacha20poly1305(key, nonce, ad).decrypt(ciphertext);
    } catch (cause) {
      // A failed decryption does not use up the nonce.
      this.#nonce = nonceValue;
      throw new NoiseError("Decryption failed.", { cause });
    }
  }
}

class SymmetricState {
  cipher = new CipherState();
  chainingKey: Uint8Array;
  hash: Uint8Array;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    this.hash = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : blake2s(name);
    this.chainingKey = this.hash;
  }

  mixHash(data: Uint8Array): void {
    this.hash = blake2s(concat(this.hash, data));
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.chainingKey, input);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, new Uint8Array(0));
    const ciphers: [CipherState, CipherState] = [new CipherState(first), new CipherState(second)];
    for (const cipher of ciphers) setNonce(cipher, getTransportNonceStart());
    return ciphers;
  }
}

export interface TransportCiphers {
  readonly send: CipherState;
  readonly receive: CipherState;
}

export type HandshakeRole = "initiator" | "responder";

export interface HandshakeOptions {
  readonly prologue: Uint8Array;
  readonly staticKeyPair: KeyPair;
  /** A fixed ephemeral key: for test vectors, or one made from the runtime's own random source. */
  readonly ephemeralKeyPair?: KeyPair;
}

/** The XK pattern (<- s ... -> e, es; <- e, ee; -> s, se): the initiator knows the responder's static key. */
export class XkHandshake {
  readonly role: HandshakeRole;
  readonly #symmetric = new SymmetricState(NOISE_PROTOCOL_NAME);
  readonly #static: KeyPair;
  readonly #fixedEphemeral: KeyPair | undefined;
  #ephemeral: KeyPair | undefined;
  #remoteStatic: Uint8Array | undefined;
  #remoteEphemeral: Uint8Array | undefined;
  #step = 0;
  #ciphers: TransportCiphers | undefined;

  private constructor(role: HandshakeRole, options: HandshakeOptions, responderStatic: Uint8Array) {
    this.role = role;
    this.#static = options.staticKeyPair;
    this.#fixedEphemeral = options.ephemeralKeyPair;
    this.#symmetric.mixHash(options.prologue);
    this.#symmetric.mixHash(responderStatic);
    if (role === "initiator") this.#remoteStatic = responderStatic;
  }

  static initiator(options: HandshakeOptions & { readonly remoteStaticKey: Uint8Array }) {
    if (options.remoteStaticKey.length !== KEY_LENGTH) {
      throw new NoiseError("The responder's static key is 32 bytes.");
    }
    return new XkHandshake("initiator", options, options.remoteStaticKey);
  }

  static responder(options: HandshakeOptions) {
    return new XkHandshake("responder", options, options.staticKeyPair.publicKey);
  }

  get isComplete(): boolean {
    return this.#ciphers !== undefined;
  }

  /** The peer's static key: known from the start for the initiator, after message 3 for the responder. */
  get remoteStaticKey(): Uint8Array | undefined {
    return this.#remoteStatic;
  }

  get handshakeHash(): Uint8Array {
    return this.#symmetric.hash;
  }

  /** Whether the next message is ours to write. */
  get isMyTurn(): boolean {
    return (this.#step % 2 === 0) === (this.role === "initiator");
  }

  get transport(): TransportCiphers {
    if (this.#ciphers === undefined) throw new NoiseError("The handshake is not complete.");
    return this.#ciphers;
  }

  #newEphemeral(): KeyPair {
    return this.#fixedEphemeral ?? generateKeyPair();
  }

  #finish(): void {
    const [first, second] = this.#symmetric.split();
    this.#ciphers =
      this.role === "initiator"
        ? { send: first, receive: second }
        : { send: second, receive: first };
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.isComplete || !this.isMyTurn) throw new NoiseError("Not this side's turn to write.");
    const s = this.#symmetric;
    const step = this.#step;
    this.#step += 1;
    if (step === 0) {
      const ephemeral = (this.#ephemeral = this.#newEphemeral());
      s.mixHash(ephemeral.publicKey);
      s.mixKey(dh(ephemeral, this.#remoteStatic!));
      return concat(ephemeral.publicKey, s.encryptAndHash(payload));
    }
    if (step === 1) {
      const ephemeral = (this.#ephemeral = this.#newEphemeral());
      s.mixHash(ephemeral.publicKey);
      s.mixKey(dh(ephemeral, this.#remoteEphemeral!));
      return concat(ephemeral.publicKey, s.encryptAndHash(payload));
    }
    const encryptedStatic = s.encryptAndHash(this.#static.publicKey);
    s.mixKey(dh(this.#static, this.#remoteEphemeral!));
    const message = concat(encryptedStatic, s.encryptAndHash(payload));
    this.#finish();
    return message;
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.isComplete || this.isMyTurn) throw new NoiseError("Not this side's turn to read.");
    if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError("Handshake message too large.");
    const s = this.#symmetric;
    const step = this.#step;
    if (step === 0 || step === 1) {
      if (message.length < KEY_LENGTH + TAG_LENGTH) {
        throw new NoiseError("Handshake message too short.");
      }
      const remoteEphemeral = message.subarray(0, KEY_LENGTH);
      this.#remoteEphemeral = remoteEphemeral;
      s.mixHash(remoteEphemeral);
      if (step === 0) {
        s.mixKey(dh(this.#static, remoteEphemeral));
      } else {
        s.mixKey(dh(this.#ephemeral!, remoteEphemeral));
      }
      const payload = s.decryptAndHash(message.subarray(KEY_LENGTH));
      this.#step += 1;
      return payload;
    }
    const staticLength = KEY_LENGTH + TAG_LENGTH;
    if (message.length < staticLength + TAG_LENGTH)
      throw new NoiseError("Handshake message too short.");
    const remoteStatic = s.decryptAndHash(message.subarray(0, staticLength));
    s.mixKey(dh(this.#ephemeral!, remoteStatic));
    const payload = s.decryptAndHash(message.subarray(staticLength));
    this.#remoteStatic = remoteStatic;
    this.#step += 1;
    this.#finish();
    return payload;
  }
}
