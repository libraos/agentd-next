// @effect-diagnostics extendsNativeError:off globalTimers:off globalDate:off - plain errors and socket timers keep this package free of Effect for React Native.
import { encodeText, type HttpHead } from "./frames.ts";
import { Multiplexer, type MuxStream } from "./mux.ts";
import { KEY_LENGTH, type KeyPair } from "./noise.ts";
import { RELAY_SUBPROTOCOL, type RelayRoute, relayDeviceEndpoint } from "./route.ts";
import { SecureSession, SessionCloseCode } from "./session.ts";

/** The parts of a WebSocket the tunnel uses; browser, React Native and undici sockets have them. */
export interface DeviceSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Opens a WebSocket with these headers; React Native and undici take them, browsers do not. */
export type DeviceSocketFactory = (
  url: string,
  protocols: ReadonlyArray<string>,
  headers: Readonly<Record<string, string>>,
) => DeviceSocket;

/**
 * Why a tunnel failed or ended. "unauthorized": the relay refused the device token, or the host
 * refused the device key (revoked, or a spent pairing code); pairing again is the fix.
 */
export type RelayTunnelFailure = "unauthorized" | "host-offline" | "unreachable" | "closed";

export class RelayTunnelError extends Error {
  override readonly name: string = "RelayTunnelError";
  readonly failure: RelayTunnelFailure;

  constructor(failure: RelayTunnelFailure, message = `Relay tunnel ${failure}.`) {
    super(message);
    this.failure = failure;
  }
}

// The relay's own close codes: 4401 bad device token, 4403 revoked, 4404 host offline.
const failureOfClose = (code: number): RelayTunnelFailure => {
  if (code === 4401 || code === 4403 || code === SessionCloseCode.NOT_AUTHORIZED) {
    return "unauthorized";
  }
  return code === 4404 ? "host-offline" : "closed";
};

export interface RelayTunnelOptions {
  readonly route: RelayRoute;
  readonly deviceKeys: KeyPair;
  /** For runtimes without crypto.getRandomValues (Hermes). */
  readonly ephemeralKeyPair?: KeyPair;
  /** The pairing link's one-time code, until the host has let this device's key in once. */
  readonly pairingCode?: string;
  readonly connect: DeviceSocketFactory;
  /** How long opening may take, through the host's first answer. */
  readonly openTimeoutMs?: number;
  /** How often the tunnel checks that the host still answers; a missed answer ends it. */
  readonly heartbeatMs?: number;
  /** A tunnel with no open stream for this long closes. */
  readonly idleCloseMs?: number;
}

export type RelayRequestBody = string | ArrayBuffer | ArrayBufferView | URLSearchParams | null;

export interface RelayRequestInit {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: RelayRequestBody | BodyInit;
  readonly signal?: AbortSignal | null;
}

export interface RelayTunnel {
  readonly isOpen: () => boolean;
  /** One HTTP request to the host, answered with its whole response. */
  readonly fetch: (url: string, init?: RelayRequestInit) => Promise<Response>;
  readonly webSocket: (url: string, protocols?: string | ReadonlyArray<string>) => RelayWebSocket;
  /** Called once when the tunnel ends. */
  readonly onClose: (listener: (failure: RelayTunnelFailure) => void) => void;
  readonly close: () => void;
  /** @internal */
  readonly openWsStream: (path: string, protocols: ReadonlyArray<string>) => MuxStream;
}

const fromBase64Url = (text: string): Uint8Array => {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): ArrayBuffer => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
};

const networkError = () => new TypeError("Network request failed");

const abortError = () => {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
};

const headerRecord = (init: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
};

const bodyBytes = (
  body: RelayRequestInit["body"],
  headers: Record<string, string>,
): Uint8Array | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return encodeText(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) {
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    return encodeText(body.toString());
  }
  throw new TypeError("This request body cannot be sent through the relay.");
};

// Statuses whose response has no body; Response refuses one for them.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const toResponse = (head: HttpHead, body: ArrayBuffer): Response => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(head.headers)) {
    for (const entry of typeof value === "string" ? [value] : value) headers.append(name, entry);
  }
  return new Response(NULL_BODY_STATUS.has(head.status) ? null : body, {
    status: head.status,
    headers,
  });
};

/** Opens a tunnel to the host and resolves once the host has answered, so it let this device in. */
export const openRelayTunnel = (options: RelayTunnelOptions): Promise<RelayTunnel> =>
  new Promise((resolve, reject) => {
    const { route } = options;
    let hostKey: Uint8Array;
    try {
      hostKey = fromBase64Url(route.hostKey);
    } catch {
      hostKey = new Uint8Array(0);
    }
    if (hostKey.length !== KEY_LENGTH) {
      reject(new RelayTunnelError("unauthorized", "The pairing link's host key is invalid."));
      return;
    }
    const openTimeoutMs = options.openTimeoutMs ?? 15_000;
    const heartbeatMs = options.heartbeatMs ?? 25_000;
    const idleCloseMs = options.idleCloseMs ?? 60_000;
    const listeners: Array<(failure: RelayTunnelFailure) => void> = [];
    let mux: Multiplexer | undefined;
    let session: SecureSession | undefined;
    let opened = false;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let idleSince: number | undefined;
    let pinging = false;

    const socket = options.connect(relayDeviceEndpoint(route), [RELAY_SUBPROTOCOL], {
      authorization: `Bearer ${route.deviceToken}`,
    });
    socket.binaryType = "arraybuffer";

    const finish = (failure: RelayTunnelFailure) => {
      if (closed) return;
      closed = true;
      clearTimeout(openTimer);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      mux?.close();
      try {
        socket.close(1000, "");
      } catch {
        // Already closed.
      }
      if (!opened) reject(new RelayTunnelError(failure));
      for (const listener of listeners.splice(0)) listener(failure);
    };
    const openTimer = setTimeout(() => finish("unreachable"), openTimeoutMs);

    const checkHost = () => {
      if (closed || mux === undefined || pinging) return;
      if (mux.openStreams > 0) {
        idleSince = undefined;
      } else {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= idleCloseMs) {
          finish("closed");
          return;
        }
      }
      pinging = true;
      const deadline = setTimeout(() => finish("closed"), Math.min(heartbeatMs, 10_000));
      void mux.ping().then(() => {
        pinging = false;
        clearTimeout(deadline);
      });
    };

    const openWsStream = (path: string, protocols: ReadonlyArray<string>): MuxStream => {
      if (closed || mux === undefined) throw networkError();
      idleSince = undefined;
      return mux.openWs({ path, headers: {}, protocols });
    };

    const fetchOverTunnel = (url: string, init: RelayRequestInit = {}): Promise<Response> => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted === true) return Promise.reject(abortError());
      if (closed || mux === undefined) return Promise.reject(networkError());
      const target = new URL(url);
      const headers = headerRecord(init.headers);
      // The host forwards the server's bytes as they are, so ask for them uncompressed.
      headers["accept-encoding"] = "identity";
      let body: Uint8Array | undefined;
      try {
        body = bodyBytes(init.body, headers);
      } catch (cause) {
        return Promise.reject(cause);
      }
      const activeMux = mux;
      idleSince = undefined;
      return new Promise((resolveResponse, rejectResponse) => {
        const stream = activeMux.openHttp({
          method: (init.method ?? "GET").toUpperCase(),
          path: `${target.pathname}${target.search}`,
          headers,
        });
        let head: HttpHead | undefined;
        const chunks: Array<Uint8Array> = [];
        const onAbort = () => {
          stream.reset();
          rejectResponse(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = () => signal?.removeEventListener("abort", onAbort);
        stream.onEvent = (event) => {
          switch (event.type) {
            case "head":
              head = event.head;
              return;
            case "data":
              chunks.push(event.data.slice());
              stream.release(event.credit);
              return;
            case "end":
              settle();
              if (head === undefined) rejectResponse(networkError());
              else resolveResponse(toResponse(head, concatChunks(chunks)));
              return;
            case "reset":
              settle();
              rejectResponse(networkError());
              return;
            default:
              return;
          }
        };
        if (body !== undefined && body.length > 0) stream.write(body);
        stream.end();
      });
    };

    const tunnel: RelayTunnel = {
      isOpen: () => opened && !closed,
      fetch: fetchOverTunnel,
      webSocket: (url, protocols) => new RelayWebSocket(url, protocols, Promise.resolve(tunnel)),
      onClose: (listener) => {
        if (closed) listener("closed");
        else listeners.push(listener);
      },
      close: () => finish("closed"),
      openWsStream,
    };

    socket.onopen = () => {
      session = SecureSession.initiator({
        transport: {
          send: (data) => {
            if (socket.readyState === 1) socket.send(data);
          },
          close: (code, reason) => socket.close(code, reason),
        },
        hostId: route.hostId,
        staticKeyPair: options.deviceKeys,
        hostStaticKey: hostKey,
        ...(options.pairingCode === undefined ? {} : { pairingCode: options.pairingCode }),
        ...(options.ephemeralKeyPair === undefined
          ? {}
          : { ephemeralKeyPair: options.ephemeralKeyPair }),
        onOpen: (open) => {
          mux = new Multiplexer({ role: "device", send: (frame) => open.send(frame) });
          // The host answers only once it has let this device in.
          void mux.ping().then(() => {
            if (closed) return;
            opened = true;
            clearTimeout(openTimer);
            heartbeat = setInterval(checkHost, heartbeatMs);
            resolve(tunnel);
          });
        },
        onMessage: (plaintext) => mux?.receive(plaintext),
        onClose: (code) => finish(failureOfClose(code)),
      });
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        session?.close(SessionCloseCode.PROTOCOL_ERROR, "text message");
        return;
      }
      session?.receive(new Uint8Array(event.data));
    };
    socket.onclose = (event) => finish(failureOfClose(event.code));
    socket.onerror = () => finish(opened ? "closed" : "unreachable");
  });

type EventListenerFn = (event: RelayWebSocketEvent) => void;

export interface RelayWebSocketEvent {
  readonly type: "open" | "message" | "close" | "error";
  readonly target: RelayWebSocket;
  readonly data?: string | ArrayBuffer;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

/** A WebSocket to the host carried as one stream of a relay tunnel. */
export class RelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  binaryType = "arraybuffer";
  protocol = "";
  readonly extensions = "";
  readyState = 0;
  onopen: EventListenerFn | null = null;
  onmessage: EventListenerFn | null = null;
  onclose: EventListenerFn | null = null;
  onerror: EventListenerFn | null = null;

  readonly #listeners = new Map<string, Array<{ fn: EventListenerFn; once: boolean }>>();
  #stream: MuxStream | undefined;
  #closeRequested = false;

  constructor(
    url: string,
    protocols: string | ReadonlyArray<string> | undefined,
    tunnel: Promise<RelayTunnel>,
  ) {
    this.url = url;
    const target = new URL(url);
    const requested =
      protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];
    tunnel.then(
      (opened) => {
        if (this.readyState === RelayWebSocket.CLOSED) return;
        let stream: MuxStream;
        try {
          stream = opened.openWsStream(`${target.pathname}${target.search}`, requested);
        } catch {
          this.#fail();
          return;
        }
        this.#stream = stream;
        stream.onEvent = (event) => this.#onStreamEvent(event);
        if (this.#closeRequested) stream.reset();
      },
      () => this.#fail(),
    );
  }

  get bufferedAmount(): number {
    return this.#stream?.bufferedAmount ?? 0;
  }

  addEventListener(type: string, fn: EventListenerFn, options?: { readonly once?: boolean }) {
    const list = this.#listeners.get(type) ?? [];
    list.push({ fn, once: options?.once === true });
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, fn: EventListenerFn) {
    const list = this.#listeners.get(type);
    if (list === undefined) return;
    this.#listeners.set(
      type,
      list.filter((entry) => entry.fn !== fn),
    );
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState === RelayWebSocket.CONNECTING) {
      throw new Error("The WebSocket is not open yet.");
    }
    const stream = this.#stream;
    if (this.readyState !== RelayWebSocket.OPEN || stream === undefined) return;
    if (typeof data === "string") stream.sendText(data);
    else if (data instanceof ArrayBuffer) stream.sendBinary(new Uint8Array(data));
    else stream.sendBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= RelayWebSocket.CLOSING) return;
    if (this.readyState === RelayWebSocket.CONNECTING) {
      this.#closeRequested = true;
      this.#stream?.reset();
      this.#finish(1006, "", false);
      return;
    }
    this.readyState = RelayWebSocket.CLOSING;
    this.#stream?.sendClose(code, reason);
  }

  #onStreamEvent(event: Parameters<MuxStream["onEvent"]>[0]) {
    switch (event.type) {
      case "accept":
        if (this.readyState !== RelayWebSocket.CONNECTING) return;
        this.readyState = RelayWebSocket.OPEN;
        this.protocol = event.protocol;
        this.#dispatch({ type: "open", target: this });
        return;
      case "text":
        this.#dispatch({ type: "message", target: this, data: event.text });
        this.#stream?.release(event.credit);
        return;
      case "binary":
        this.#dispatch({ type: "message", target: this, data: event.data.slice().buffer });
        this.#stream?.release(event.credit);
        return;
      case "close":
        // Answer the host's close, as a WebSocket does, unless this side started it.
        if (this.readyState === RelayWebSocket.OPEN) {
          const code = event.close.code;
          this.#stream?.sendClose(code === 1005 || code === 1006 || code === 1015 ? 1000 : code);
        }
        this.#finish(event.close.code, event.close.reason, true);
        return;
      case "reject":
      case "reset":
        this.#fail();
        return;
      default:
        return;
    }
  }

  #fail() {
    if (this.readyState === RelayWebSocket.CLOSED) return;
    this.#dispatch({ type: "error", target: this });
    this.#finish(1006, "", false);
  }

  #finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === RelayWebSocket.CLOSED) return;
    this.readyState = RelayWebSocket.CLOSED;
    this.#dispatch({ type: "close", target: this, code, reason, wasClean });
  }

  #dispatch(event: RelayWebSocketEvent) {
    const handler = this[`on${event.type}`];
    handler?.call(this, event);
    const list = this.#listeners.get(event.type);
    if (list === undefined) return;
    this.#listeners.set(
      event.type,
      list.filter((entry) => !entry.once),
    );
    for (const entry of list) entry.fn(event);
  }
}
