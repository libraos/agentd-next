// @effect-diagnostics nodeBuiltinImport:off - streams requests to this server with node:http, driven by mux callbacks.
import * as NodeHttp from "node:http";

import type { Headers, HttpOpen, WsOpen } from "@t3tools/relay-session/frames";
import type { MuxStream } from "@t3tools/relay-session/mux";
// `ws`, not undici: undici drops a Host header, and the server must see the host the device addressed.
import { WebSocket } from "ws";

// The local server stops reading a response once this much waits on the device's credit.
const HIGH_WATER = 512 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// The server would trust these from a loopback peer, so a device must not be able to send them.
const FORWARDING = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const WEBSOCKET_HANDSHAKE = /^sec-websocket-/;

const sanitizeRequestHeaders = (headers: Headers): Record<string, string | Array<string>> => {
  const out: Record<string, string | Array<string>> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || FORWARDING.has(name) || WEBSOCKET_HANDSHAKE.test(name)) continue;
    out[name] = typeof value === "string" ? value : [...value];
  }
  return out;
};

const responseHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
): Record<string, string | Array<string>> => {
  const out: Record<string, string | Array<string>> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
};

export interface LoopbackTarget {
  /** The address the server listens on, as a URL host: 127.0.0.1, [::1] or a bound address. */
  readonly host: string;
  readonly port: number;
  /**
   * The HTTPS host the device addressed (see relayBaseUrl), passed on as a local TLS proxy would,
   * so the server checks a DPoP proof against the URL the device signed.
   */
  readonly originHost?: string;
}

const targetHeaders = (target: LoopbackTarget): Record<string, string> =>
  target.originHost === undefined
    ? { host: `${target.host}:${String(target.port)}` }
    : { host: target.originHost, "x-forwarded-proto": "https" };

/** Sends one HTTP stream to the server and its response back. */
export const forwardHttpStream = (target: LoopbackTarget, stream: MuxStream, open: HttpOpen) => {
  let headSent = false;
  let response: NodeHttp.IncomingMessage | undefined;
  const request = NodeHttp.request({
    host: target.host.replace(/^\[|\]$/g, ""),
    port: target.port,
    method: open.method,
    path: open.path,
    headers: { ...sanitizeRequestHeaders(open.headers), ...targetHeaders(target) },
  });
  request.on("response", (incoming) => {
    response = incoming;
    headSent = true;
    stream.sendHead({
      status: incoming.statusCode ?? 502,
      headers: responseHeaders(incoming.headers),
    });
    incoming.on("data", (chunk: Buffer) => {
      stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (stream.bufferedAmount > HIGH_WATER) incoming.pause();
    });
    incoming.on("end", () => stream.end());
    incoming.on("error", () => stream.reset());
  });
  request.on("error", () => {
    if (stream.closed) return;
    if (headSent) {
      stream.reset();
      return;
    }
    headSent = true;
    stream.sendHead({ status: 502, headers: {} });
    stream.end();
  });
  stream.onEvent = (event) => {
    switch (event.type) {
      case "data":
        request.write(event.data, () => stream.release(event.credit));
        return;
      case "end":
        request.end();
        return;
      case "drain":
        response?.resume();
        return;
      case "reset":
        request.destroy();
        response?.destroy();
        return;
      default:
        stream.reset();
    }
  };
};

// A WebSocket handshake takes one value per header.
const singleValued = (headers: Record<string, string | Array<string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string" ? value : value.join(name === "cookie" ? "; " : ", "),
    ]),
  );

const toCloseCode = (code: number) =>
  code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

/** Opens the WebSocket on the server and pipes its messages both ways. */
export const forwardWsStream = (target: LoopbackTarget, stream: MuxStream, open: WsOpen) => {
  const socket = new WebSocket(
    `ws://${target.host}:${String(target.port)}${open.path}`,
    [...open.protocols],
    {
      headers: { ...singleValued(sanitizeRequestHeaders(open.headers)), ...targetHeaders(target) },
      perMessageDeflate: false,
    },
  );
  socket.binaryType = "arraybuffer";
  let accepted = false;
  socket.on("open", () => {
    accepted = true;
    stream.accept(socket.protocol);
  });
  socket.on("message", (data: ArrayBuffer, isBinary: boolean) => {
    if (isBinary) stream.sendBinary(new Uint8Array(data));
    else stream.sendText(Buffer.from(data).toString("utf8"));
  });
  socket.on("error", () => {});
  socket.on("close", (code: number, reason: Buffer) => {
    if (stream.closed) return;
    if (accepted) stream.sendClose(code, reason.toString("utf8"));
    else stream.reject(502);
  });
  const send = (data: string | Uint8Array, credit: number) => {
    if (socket.readyState !== WebSocket.OPEN) {
      stream.reset();
      socket.close();
      return;
    }
    socket.send(data);
    stream.release(credit);
  };
  stream.onEvent = (event) => {
    switch (event.type) {
      case "text":
        send(event.text, event.credit);
        return;
      case "binary":
        send(event.data, event.credit);
        return;
      case "close":
        socket.close(toCloseCode(event.close.code), event.close.reason);
        return;
      case "reset":
        socket.close();
        return;
      case "drain":
        return;
      default:
        stream.reset();
        socket.close();
    }
  };
};
