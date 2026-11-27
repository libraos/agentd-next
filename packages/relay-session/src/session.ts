import { encodeJson, encodeText, decodeJson } from "./frames.ts";
import {
  type KeyPair,
  MAX_TRANSPORT_PLAINTEXT,
  NoiseError,
  NonceLimitError,
  type TransportCiphers,
  XkHandshake,
} from "./noise.ts";

export const RELAY_PROLOGUE_PREFIX = "libraos-relay/1";

export const relayPrologue = (hostId: string): Uint8Array =>
  encodeText(`${RELAY_PROLOGUE_PREFIX}${hostId}`);

export const SessionCloseCode = {
  NORMAL: 1000,
  /** A message failed to decrypt or broke the protocol. */
  PROTOCOL_ERROR: 1002,
  /** The host does not know the device and it brought no valid pairing code. */
  NOT_AUTHORIZED: 1008,
  /** The nonce limit is near; the device reconnects for a fresh handshake. */
  REKEY: 4000,
} as const;

/** One WebSocket, or anything else that carries whole binary messages in order. */
export interface MessageTransport {
  readonly send: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

/** The third handshake message's payload. */
export interface HandshakeClaims {
  readonly pairing?: string;
}

const readClaims = (payload: Uint8Array): HandshakeClaims => {
  if (payload.length === 0) return {};
  const value = decodeJson(payload);
  if (typeof value !== "object" || value === null) return {};
  const pairing = (value as { pairing?: unknown }).pairing;
  return typeof pairing === "string" ? { pairing } : {};
};

interface SessionCallbacks {
  /** The handshake finished and the peer is accepted. */
  readonly onOpen?: (session: SecureSession) => void;
  readonly onMessage?: (plaintext: Uint8Array) => void;
  readonly onClose?: (code: number, reason: string) => void;
}

export interface ResponderOptions extends SessionCallbacks {
  readonly transport: MessageTransport;
  readonly hostId: string;
  readonly staticKeyPair: KeyPair;
  /** Decides whether the device may in; nothing reaches onMessage before it says yes. */
  readonly authorize: (
    deviceStaticKey: Uint8Array,
    claims: HandshakeClaims,
  ) => boolean | Promise<boolean>;
}

export interface InitiatorOptions extends SessionCallbacks {
  readonly transport: MessageTransport;
  readonly hostId: string;
  readonly staticKeyPair: KeyPair;
  readonly hostStaticKey: Uint8Array;
  /** The one-time code from the pairing link, sent only on first contact. */
  readonly pairingCode?: string;
}

/** A Noise XK session carried one Noise message per transport message. */
export class SecureSession {
  readonly #transport: MessageTransport;
  readonly #handshake: XkHandshake;
  readonly #callbacks: SessionCallbacks;
  readonly #authorize: ResponderOptions["authorize"] | undefined;
  readonly #pairingCode: string | undefined;
  #ciphers: TransportCiphers | undefined;
  #inbox: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    transport: MessageTransport,
    handshake: XkHandshake,
    callbacks: SessionCallbacks,
    authorize?: ResponderOptions["authorize"],
    pairingCode?: string,
  ) {
    this.#transport = transport;
    this.#handshake = handshake;
    this.#callbacks = callbacks;
    this.#authorize = authorize;
    this.#pairingCode = pairingCode;
  }

  static responder(options: ResponderOptions): SecureSession {
    const handshake = XkHandshake.responder({
      prologue: relayPrologue(options.hostId),
      staticKeyPair: options.staticKeyPair,
    });
    return new SecureSession(options.transport, handshake, options, options.authorize);
  }

  /** Starts the handshake by sending its first message. */
  static initiator(options: InitiatorOptions): SecureSession {
    const handshake = XkHandshake.initiator({
      prologue: relayPrologue(options.hostId),
      staticKeyPair: options.staticKeyPair,
      remoteStaticKey: options.hostStaticKey,
    });
    const session = new SecureSession(
      options.transport,
      handshake,
      options,
      undefined,
      options.pairingCode,
    );
    options.transport.send(handshake.writeMessage());
    return session;
  }

  get isOpen(): boolean {
    return this.#ciphers !== undefined && !this.#closed;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get remoteStaticKey(): Uint8Array | undefined {
    return this.#handshake.remoteStaticKey;
  }

  /** Feeds one incoming transport message. Messages are handled strictly in order. */
  receive(data: Uint8Array): void {
    this.#inbox = this.#inbox.then(() => this.#handle(data));
  }

  /** Resolves once every message received so far has been handled. */
  settled(): Promise<void> {
    return this.#inbox;
  }

  send(plaintext: Uint8Array): void {
    if (this.#closed) return;
    if (this.#ciphers === undefined) throw new NoiseError("The session is not open.");
    if (plaintext.length > MAX_TRANSPORT_PLAINTEXT) throw new NoiseError("Message too large.");
    let ciphertext: Uint8Array;
    try {
      ciphertext = this.#ciphers.send.encryptWithAd(new Uint8Array(0), plaintext);
    } catch {
      this.close(SessionCloseCode.REKEY, "nonce limit");
      return;
    }
    this.#transport.send(ciphertext);
  }

  close(code: number = SessionCloseCode.NORMAL, reason = ""): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.close(code, reason);
    this.#callbacks.onClose?.(code, reason);
  }

  async #handle(data: Uint8Array): Promise<void> {
    if (this.#closed) return;
    if (this.#ciphers !== undefined) {
      let plaintext: Uint8Array;
      try {
        plaintext = this.#ciphers.receive.decryptWithAd(new Uint8Array(0), data);
      } catch (cause) {
        const nonceExhausted = cause instanceof NonceLimitError;
        this.close(
          nonceExhausted ? SessionCloseCode.REKEY : SessionCloseCode.PROTOCOL_ERROR,
          nonceExhausted ? "nonce limit" : "decryption failed",
        );
        return;
      }
      try {
        this.#callbacks.onMessage?.(plaintext);
      } catch {
        this.close(SessionCloseCode.PROTOCOL_ERROR, "protocol error");
      }
      return;
    }
    try {
      await this.#handshakeStep(data);
    } catch {
      this.close(SessionCloseCode.PROTOCOL_ERROR, "handshake failed");
    }
  }

  async #handshakeStep(data: Uint8Array): Promise<void> {
    const handshake = this.#handshake;
    if (handshake.role === "initiator") {
      handshake.readMessage(data);
      const claims: HandshakeClaims =
        this.#pairingCode === undefined ? {} : { pairing: this.#pairingCode };
      this.#transport.send(
        handshake.writeMessage(this.#pairingCode === undefined ? undefined : encodeJson(claims)),
      );
      this.#open();
      return;
    }
    const payload = handshake.readMessage(data);
    if (!handshake.isComplete) {
      this.#transport.send(handshake.writeMessage());
      return;
    }
    const allowed = await this.#authorize!(handshake.remoteStaticKey!, readClaims(payload));
    if (this.#closed) return;
    if (!allowed) {
      this.close(SessionCloseCode.NOT_AUTHORIZED, "not authorized");
      return;
    }
    this.#open();
  }

  #open(): void {
    this.#ciphers = this.#handshake.transport;
    this.#callbacks.onOpen?.(this);
  }
}
