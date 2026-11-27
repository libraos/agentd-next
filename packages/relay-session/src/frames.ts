// @effect-diagnostics extendsNativeError:off - plain errors keep this package free of Effect for React Native.
import { MAX_TRANSPORT_PLAINTEXT } from "./noise.ts";

/** Multiplexer frame types. A frame is: type (1 byte), stream id (4 bytes, big-endian), payload. */
export const FrameType = {
  HTTP_OPEN: 0x01,
  HTTP_HEAD: 0x02,
  BODY: 0x03,
  END: 0x04,
  WS_OPEN: 0x05,
  WS_ACCEPT: 0x06,
  WS_REJECT: 0x07,
  WS_TEXT: 0x08,
  WS_BINARY: 0x09,
  WS_CLOSE: 0x0a,
  WINDOW: 0x0b,
  RESET: 0x0c,
  PING: 0x0d,
  PONG: 0x0e,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/**
 * Set on a WS_TEXT or WS_BINARY frame whose WebSocket message continues in the stream's next frame,
 * because one message can be larger than one Noise message.
 */
export const FRAME_CONTINUES = 0x80;

export const FRAME_HEADER_LENGTH = 5;
export const MAX_FRAME_PAYLOAD = MAX_TRANSPORT_PLAINTEXT - FRAME_HEADER_LENGTH;
/** Credit each side of a stream starts with, in payload bytes of BODY, WS_TEXT and WS_BINARY. */
export const INITIAL_WINDOW = 256 * 1024;
export const MAX_STREAM_ID = 0xffff_ffff;

const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(FrameType));

export class FrameError extends Error {
  override readonly name: string = "FrameError";
}

export interface Frame {
  readonly type: FrameType;
  readonly continues: boolean;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

export const encodeFrame = (
  type: FrameType,
  streamId: number,
  payload: Uint8Array = new Uint8Array(0),
  continues = false,
): Uint8Array => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new FrameError("Stream ids are unsigned 32-bit integers.");
  }
  if (payload.length > MAX_FRAME_PAYLOAD) throw new FrameError("Frame payload too large.");
  const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
  frame[0] = continues ? type | FRAME_CONTINUES : type;
  new DataView(frame.buffer).setUint32(1, streamId, false);
  frame.set(payload, FRAME_HEADER_LENGTH);
  return frame;
};

export const decodeFrame = (bytes: Uint8Array): Frame => {
  if (bytes.length < FRAME_HEADER_LENGTH) throw new FrameError("Frame too short.");
  const typeByte = bytes[0]!;
  const type = typeByte & ~FRAME_CONTINUES;
  const continues = (typeByte & FRAME_CONTINUES) !== 0;
  if (!KNOWN_TYPES.has(type)) throw new FrameError(`Unknown frame type ${String(type)}.`);
  if (continues && type !== FrameType.WS_TEXT && type !== FrameType.WS_BINARY) {
    throw new FrameError("Only WebSocket message frames continue.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: type as FrameType,
    continues,
    streamId: view.getUint32(1, false),
    payload: bytes.subarray(FRAME_HEADER_LENGTH),
  };
};

export const encodeUint32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
};

export const decodeUint32 = (bytes: Uint8Array): number => {
  if (bytes.length !== 4) throw new FrameError("Expected a 4-byte value.");
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const encodeText = (text: string): Uint8Array => textEncoder.encode(text);

export const decodeText = (bytes: Uint8Array): string => {
  try {
    return textDecoder.decode(bytes);
  } catch (cause) {
    throw new FrameError("Invalid UTF-8.", { cause });
  }
};

export const encodeJson = (value: unknown): Uint8Array => encodeText(JSON.stringify(value));

export const decodeJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decodeText(bytes));
  } catch (cause) {
    throw new FrameError("Invalid JSON payload.", { cause });
  }
};

export type Headers = Readonly<Record<string, string | ReadonlyArray<string>>>;

export interface HttpOpen {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}

export interface HttpHead {
  readonly status: number;
  readonly headers: Headers;
}

export interface WsOpen {
  readonly path: string;
  readonly headers: Headers;
  readonly protocols: ReadonlyArray<string>;
}

export interface WsClose {
  readonly code: number;
  readonly reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readHeaders = (value: unknown): Headers => {
  if (!isRecord(value)) throw new FrameError("headers must be an object.");
  const headers: Record<string, string | ReadonlyArray<string>> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      headers[name] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      headers[name] = entry as ReadonlyArray<string>;
    } else {
      throw new FrameError(`Header ${name} must be a string or a list of strings.`);
    }
  }
  return headers;
};

// Paths are origin-relative, so a stream cannot name another host.
const readPath = (value: unknown): string => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw new FrameError("path must start with a single /.");
  }
  return value;
};

export const parseHttpOpen = (payload: Uint8Array): HttpOpen => {
  const value = decodeJson(payload);
  if (!isRecord(value) || typeof value.method !== "string" || !/^[A-Z]+$/.test(value.method)) {
    throw new FrameError("HTTP_OPEN needs a method.");
  }
  return {
    method: value.method,
    path: readPath(value.path),
    headers: readHeaders(value.headers ?? {}),
  };
};

export const parseHttpHead = (payload: Uint8Array): HttpHead => {
  const value = decodeJson(payload);
  if (!isRecord(value) || typeof value.status !== "number")
    throw new FrameError("HTTP_HEAD needs a status.");
  return { status: value.status, headers: readHeaders(value.headers ?? {}) };
};

export const parseWsOpen = (payload: Uint8Array): WsOpen => {
  const value = decodeJson(payload);
  if (!isRecord(value)) throw new FrameError("WS_OPEN needs an object.");
  const protocols = value.protocols ?? [];
  if (!Array.isArray(protocols) || !protocols.every((item) => typeof item === "string")) {
    throw new FrameError("protocols must be a list of strings.");
  }
  return {
    path: readPath(value.path),
    headers: readHeaders(value.headers ?? {}),
    protocols: protocols as ReadonlyArray<string>,
  };
};

export const parseWsClose = (payload: Uint8Array): WsClose => {
  if (payload.length === 0) return { code: 1005, reason: "" };
  const value = decodeJson(payload);
  if (!isRecord(value) || typeof value.code !== "number")
    throw new FrameError("WS_CLOSE needs a code.");
  return { code: value.code, reason: typeof value.reason === "string" ? value.reason : "" };
};
