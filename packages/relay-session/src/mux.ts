import {
  decodeFrame,
  decodeJson,
  decodeText,
  decodeUint32,
  encodeFrame,
  encodeJson,
  encodeText,
  encodeUint32,
  type Frame,
  FrameError,
  FrameType,
  type HttpHead,
  type HttpOpen,
  INITIAL_WINDOW,
  MAX_FRAME_PAYLOAD,
  parseHttpHead,
  parseHttpOpen,
  parseWsClose,
  parseWsOpen,
  type WsClose,
  type WsOpen,
} from "./frames.ts";

/** Credit is returned in batches once this much has been consumed; at most INITIAL_WINDOW - MAX_FRAME_PAYLOAD. */
export const WINDOW_UPDATE_THRESHOLD = 64 * 1024;
export const MAX_OPEN_STREAMS = 256;
const MAX_CREDIT = 0x7fff_ffff;

export type MuxRole = "device" | "host";
export type StreamKind = "http" | "ws";

/**
 * Events a stream delivers. `credit` is how many bytes to pass to `release` once the data is consumed;
 * the peer stops sending when it runs out.
 */
export type StreamEvent =
  | { readonly type: "head"; readonly head: HttpHead }
  | { readonly type: "data"; readonly data: Uint8Array; readonly credit: number }
  | { readonly type: "end" }
  | { readonly type: "accept"; readonly protocol: string }
  | { readonly type: "reject"; readonly status: number }
  | { readonly type: "text"; readonly text: string; readonly credit: number }
  | { readonly type: "binary"; readonly data: Uint8Array; readonly credit: number }
  | { readonly type: "close"; readonly close: WsClose }
  | { readonly type: "drain" }
  | { readonly type: "reset" };

interface Outgoing {
  readonly type: FrameType;
  readonly payload: Uint8Array;
  readonly continues: boolean;
  /** Credit it uses: the payload length for data frames, 0 for control frames. */
  readonly cost: number;
}

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export class MuxStream {
  readonly id: number;
  readonly kind: StreamKind;
  onEvent: (event: StreamEvent) => void = () => {};

  readonly #mux: Multiplexer;
  #sendCredit = INITIAL_WINDOW;
  #receiveCredit = INITIAL_WINDOW;
  #unreleased = 0;
  #queue: Array<Outgoing> = [];
  #queuedBytes = 0;
  #fragments: Array<Uint8Array> = [];
  #fragmentType: number | undefined;
  #localDone = false;
  #remoteDone = false;
  #closed = false;

  constructor(mux: Multiplexer, id: number, kind: StreamKind) {
    this.#mux = mux;
    this.id = id;
    this.kind = kind;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Payload bytes queued because the peer has not granted credit for them yet. */
  get bufferedAmount(): number {
    return this.#queuedBytes;
  }

  get sendCredit(): number {
    return this.#sendCredit;
  }

  sendHead(head: HttpHead): void {
    this.#enqueue(FrameType.HTTP_HEAD, encodeJson(head));
  }

  write(data: Uint8Array): void {
    for (let offset = 0; offset < data.length; offset += MAX_FRAME_PAYLOAD) {
      const chunk = data.subarray(offset, offset + MAX_FRAME_PAYLOAD);
      this.#enqueue(FrameType.BODY, chunk, false, chunk.length);
    }
  }

  end(): void {
    if (this.#localDone) return;
    this.#enqueue(FrameType.END, new Uint8Array(0));
    this.#localDone = true;
    this.#maybeFinish();
  }

  accept(protocol: string): void {
    this.#enqueue(FrameType.WS_ACCEPT, encodeJson({ protocol }));
  }

  reject(status: number): void {
    this.#enqueue(FrameType.WS_REJECT, encodeJson({ status }));
    this.#finish();
  }

  sendText(text: string): void {
    this.#sendMessage(FrameType.WS_TEXT, encodeText(text));
  }

  sendBinary(data: Uint8Array): void {
    this.#sendMessage(FrameType.WS_BINARY, data);
  }

  sendClose(code: number, reason = ""): void {
    if (this.#localDone) return;
    this.#enqueue(FrameType.WS_CLOSE, encodeJson({ code, reason }));
    this.#localDone = true;
    this.#maybeFinish();
  }

  /** Abandons the stream in both directions. */
  reset(): void {
    if (this.#closed) return;
    this.#mux.sendRaw(encodeFrame(FrameType.RESET, this.id));
    this.#finish();
  }

  /** Returns credit for consumed bytes; see StreamEvent. */
  release(bytes: number): void {
    if (this.#closed || bytes <= 0) return;
    this.#unreleased += bytes;
    if (this.#unreleased < WINDOW_UPDATE_THRESHOLD) return;
    const grant = this.#unreleased;
    this.#unreleased = 0;
    this.#receiveCredit += grant;
    this.#mux.sendRaw(encodeFrame(FrameType.WINDOW, this.id, encodeUint32(grant)));
  }

  #sendMessage(
    type: typeof FrameType.WS_TEXT | typeof FrameType.WS_BINARY,
    data: Uint8Array,
  ): void {
    if (data.length === 0) {
      this.#enqueue(type, data);
      return;
    }
    for (let offset = 0; offset < data.length; offset += MAX_FRAME_PAYLOAD) {
      const chunk = data.subarray(offset, offset + MAX_FRAME_PAYLOAD);
      const continues = offset + MAX_FRAME_PAYLOAD < data.length;
      this.#enqueue(type, chunk, continues, chunk.length);
    }
  }

  #enqueue(type: FrameType, payload: Uint8Array, continues = false, cost = 0): void {
    if (this.#closed || this.#localDone) return;
    this.#queue.push({ type, payload, continues, cost });
    this.#queuedBytes += cost;
    this.#flush();
  }

  #flush(): void {
    const hadQueued = this.#queuedBytes > 0;
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      let next = head;
      if (head.cost > this.#sendCredit) {
        if (this.#sendCredit === 0) break;
        // Send what the credit allows; a WebSocket message marks the cut as continued.
        const credit = this.#sendCredit;
        next = {
          ...head,
          payload: head.payload.subarray(0, credit),
          continues: head.type !== FrameType.BODY,
          cost: credit,
        };
        this.#queue[0] = {
          ...head,
          payload: head.payload.subarray(credit),
          cost: head.cost - credit,
        };
      } else {
        this.#queue.shift();
      }
      this.#sendCredit -= next.cost;
      this.#queuedBytes -= next.cost;
      this.#mux.sendRaw(encodeFrame(next.type, this.id, next.payload, next.continues));
    }
    if (hadQueued && this.#queuedBytes === 0 && !this.#closed) this.onEvent({ type: "drain" });
  }

  #maybeFinish(): void {
    if (this.#localDone && this.#remoteDone && this.#queue.length === 0) this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#fragments = [];
    this.#mux.forget(this);
  }

  /** @internal */
  receive(frame: Frame): void {
    if (this.#closed) return;
    switch (frame.type) {
      case FrameType.WINDOW: {
        const grant = decodeUint32(frame.payload);
        if (grant === 0 || this.#sendCredit + grant > MAX_CREDIT) {
          throw new FrameError("Invalid WINDOW credit.");
        }
        this.#sendCredit += grant;
        this.#flush();
        this.#maybeFinish();
        return;
      }
      case FrameType.RESET:
        this.#finish();
        this.onEvent({ type: "reset" });
        return;
      case FrameType.BODY:
      case FrameType.WS_TEXT:
      case FrameType.WS_BINARY:
        this.#receiveData(frame);
        return;
      case FrameType.END:
      case FrameType.WS_CLOSE:
        this.#remoteDone = true;
        this.onEvent(
          frame.type === FrameType.END
            ? { type: "end" }
            : { type: "close", close: parseWsClose(frame.payload) },
        );
        this.#maybeFinish();
        return;
      case FrameType.HTTP_HEAD:
        this.onEvent({ type: "head", head: parseHttpHead(frame.payload) });
        return;
      case FrameType.WS_ACCEPT: {
        const value = decodeJson(frame.payload) as { protocol?: unknown } | null;
        this.onEvent({
          type: "accept",
          protocol: typeof value?.protocol === "string" ? value.protocol : "",
        });
        return;
      }
      case FrameType.WS_REJECT: {
        const value = decodeJson(frame.payload) as { status?: unknown } | null;
        this.#finish();
        this.onEvent({
          type: "reject",
          status: typeof value?.status === "number" ? value.status : 0,
        });
        return;
      }
      default:
        throw new FrameError(`Unexpected frame type ${String(frame.type)} on a stream.`);
    }
  }

  #receiveData(frame: Frame): void {
    const size = frame.payload.length;
    if (size > this.#receiveCredit) throw new FrameError("Peer sent past its credit.");
    this.#receiveCredit -= size;
    if (frame.type === FrameType.BODY) {
      this.onEvent({ type: "data", data: frame.payload, credit: size });
      return;
    }
    if (this.#fragmentType !== undefined && this.#fragmentType !== frame.type) {
      throw new FrameError("A continued WebSocket message changed type.");
    }
    if (frame.continues) {
      this.#fragmentType = frame.type;
      // Buffered here, so the peer must not wait on the consumer for these bytes.
      this.#fragments.push(frame.payload.slice());
      this.release(size);
      return;
    }
    const data =
      this.#fragments.length === 0
        ? frame.payload
        : concatChunks([...this.#fragments, frame.payload]);
    this.#fragments = [];
    this.#fragmentType = undefined;
    this.onEvent(
      frame.type === FrameType.WS_TEXT
        ? { type: "text", text: decodeText(data), credit: size }
        : { type: "binary", data, credit: size },
    );
  }
}

export interface MultiplexerOptions {
  readonly role: MuxRole;
  /** Sends one frame as one transport message. */
  readonly send: (frame: Uint8Array) => void;
  /** Host only: the device opened an HTTP request. */
  readonly onHttpStream?: (stream: MuxStream, open: HttpOpen) => void;
  /** Host only: the device opened a WebSocket. */
  readonly onWsStream?: (stream: MuxStream, open: WsOpen) => void;
}

/** One end of the stream multiplexer; it neither encrypts nor owns the socket. */
export class Multiplexer {
  readonly role: MuxRole;
  readonly #options: MultiplexerOptions;
  readonly #streams = new Map<number, MuxStream>();
  readonly #pings = new Map<string, () => void>();
  #nextStreamId = 1;
  #lastRemoteStreamId = 0;
  #pingCounter = 0;
  #closed = false;

  constructor(options: MultiplexerOptions) {
    this.role = options.role;
    this.#options = options;
  }

  get openStreams(): number {
    return this.#streams.size;
  }

  stream(id: number): MuxStream | undefined {
    return this.#streams.get(id);
  }

  openHttp(open: HttpOpen): MuxStream {
    const stream = this.#openLocal("http");
    this.sendRaw(encodeFrame(FrameType.HTTP_OPEN, stream.id, encodeJson(open)));
    return stream;
  }

  openWs(open: WsOpen): MuxStream {
    const stream = this.#openLocal("ws");
    this.sendRaw(encodeFrame(FrameType.WS_OPEN, stream.id, encodeJson(open)));
    return stream;
  }

  /** Resolves when the peer answers; never rejects, so pair it with a timeout. */
  ping(): Promise<void> {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    this.#pingCounter += 1;
    view.setUint32(0, Math.floor(this.#pingCounter / 0x1_0000_0000));
    view.setUint32(4, this.#pingCounter >>> 0);
    const key = payload.join(",");
    return new Promise((resolve) => {
      this.#pings.set(key, resolve);
      this.sendRaw(encodeFrame(FrameType.PING, 0, payload));
    });
  }

  /** Feeds one decrypted transport message. Throws FrameError on a protocol violation; close the session then. */
  receive(bytes: Uint8Array): void {
    if (this.#closed) return;
    const frame = decodeFrame(bytes);
    switch (frame.type) {
      case FrameType.PING:
        if (frame.payload.length !== 8) throw new FrameError("PING carries 8 bytes.");
        this.sendRaw(encodeFrame(FrameType.PONG, 0, frame.payload));
        return;
      case FrameType.PONG: {
        const key = frame.payload.join(",");
        this.#pings.get(key)?.();
        this.#pings.delete(key);
        return;
      }
      case FrameType.HTTP_OPEN:
        this.#openRemote(frame, "http");
        return;
      case FrameType.WS_OPEN:
        this.#openRemote(frame, "ws");
        return;
      default:
        // Frames for a stream that has finished may still be in flight.
        this.#streams.get(frame.streamId)?.receive(frame);
    }
  }

  /** Drops every stream without telling the peer; for when the session itself ends. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const stream of streams) stream.onEvent({ type: "reset" });
    this.#pings.clear();
  }

  /** @internal */
  sendRaw(frame: Uint8Array): void {
    if (!this.#closed) this.#options.send(frame);
  }

  /** @internal */
  forget(stream: MuxStream): void {
    if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
  }

  #openLocal(kind: StreamKind): MuxStream {
    if (this.role !== "device") throw new FrameError("Only the device opens streams.");
    if (this.#nextStreamId > 0xffff_ffff) throw new FrameError("Stream ids exhausted.");
    const stream = new MuxStream(this, this.#nextStreamId, kind);
    this.#nextStreamId += 2;
    this.#streams.set(stream.id, stream);
    return stream;
  }

  #openRemote(frame: Frame, kind: StreamKind): void {
    if (this.role !== "host") throw new FrameError("Only the device opens streams.");
    if (frame.streamId % 2 !== 1) throw new FrameError("Device streams have odd ids.");
    if (frame.streamId <= this.#lastRemoteStreamId)
      throw new FrameError("Stream ids only increase.");
    this.#lastRemoteStreamId = frame.streamId;
    const stream = new MuxStream(this, frame.streamId, kind);
    if (this.#streams.size >= MAX_OPEN_STREAMS) {
      stream.reset();
      return;
    }
    this.#streams.set(stream.id, stream);
    if (kind === "http") {
      const open = parseHttpOpen(frame.payload);
      if (this.#options.onHttpStream === undefined) stream.reset();
      else this.#options.onHttpStream(stream, open);
    } else {
      const open = parseWsOpen(frame.payload);
      if (this.#options.onWsStream === undefined) stream.reset();
      else this.#options.onWsStream(stream, open);
    }
  }
}
