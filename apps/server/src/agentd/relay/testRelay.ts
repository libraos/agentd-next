// @effect-diagnostics nodeBuiltinImport:off - an in-process relay on real sockets, for tests.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { Multiplexer } from "@t3tools/relay-session/mux";
import type { KeyPair } from "@t3tools/relay-session/noise";
import { SecureSession } from "@t3tools/relay-session/session";
import { WebSocket } from "undici";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

export const TEST_HOST_TOKEN = "host-token";
export const TEST_HOST_ID = "0123456789abcdef0123456789abcdef";

export interface DeviceConnection {
  readonly mux: Multiplexer;
  readonly session: SecureSession;
  readonly closed: Promise<number>;
}

/** A phone reaching the host through the relay: Noise handshake, then the multiplexer. */
export const connectDevice = (input: {
  readonly relayUrl: string;
  readonly deviceToken: string;
  readonly deviceKeys: KeyPair;
  readonly hostKey: Uint8Array;
  readonly pairingCode?: string;
  /** Sent with the first message after the handshake, before the host has answered. */
  readonly sendAtOnce?: (mux: Multiplexer) => void;
}) =>
  new Promise<DeviceConnection>((resolve, reject) => {
    const socket = new WebSocket(
      `${input.relayUrl.replace("http", "ws")}/relay/v1/device?host=${TEST_HOST_ID}`,
      { headers: { authorization: `Bearer ${input.deviceToken}` } },
    );
    socket.binaryType = "arraybuffer";
    let resolveClosed: (code: number) => void = () => {};
    const closed = new Promise<number>((done) => (resolveClosed = done));
    let mux: Multiplexer | undefined;
    socket.addEventListener("open", () => {
      const session = SecureSession.initiator({
        transport: { send: (data) => socket.send(data), close: (code) => socket.close(code) },
        hostId: TEST_HOST_ID,
        staticKeyPair: input.deviceKeys,
        hostStaticKey: input.hostKey,
        ...(input.pairingCode === undefined ? {} : { pairingCode: input.pairingCode }),
        onOpen: (opened) => {
          mux = new Multiplexer({ role: "device", send: (frame) => opened.send(frame) });
          input.sendAtOnce?.(mux);
          resolve({ mux, session: opened, closed });
        },
        onMessage: (plaintext) => mux?.receive(plaintext),
      });
      socket.addEventListener("message", (event) =>
        session.receive(new Uint8Array(event.data as ArrayBuffer)),
      );
    });
    socket.addEventListener("close", (event) => {
      resolveClosed(event.code);
      reject(new Error(`closed ${String(event.code)}`));
    });
  });

export const listen = (server: NodeHttp.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port)),
  );

const bearer = (request: NodeHttp.IncomingMessage) =>
  request.headers.authorization?.replace(/^Bearer /, "") ?? "";

/** A relay that routes and pipes as the protocol says, and never looks inside messages. */
export const startTestRelay = async () => {
  const server = NodeHttp.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const devices = new Map<string, string>();
  const revoked: Array<string> = [];
  const pending = new Map<string, { device: WsSocket; queued: Array<Buffer> }>();
  const controlWaiters: Array<(socket: WsSocket) => void> = [];
  let control: WsSocket | undefined;
  let nextId = 0;
  const id = () => `id${String((nextId += 1))}`;

  server.on("request", (request, response) => {
    if (bearer(request) !== TEST_HOST_TOKEN) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && request.url === "/relay/v1/devices") {
      const deviceId = id();
      const deviceToken = `device-token-${deviceId}`;
      devices.set(deviceToken, deviceId);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ deviceId, deviceToken }));
      return;
    }
    const revoke = /^\/relay\/v1\/devices\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && revoke !== null) {
      const deviceId = decodeURIComponent(revoke[1]!);
      for (const [token, owner] of devices) if (owner === deviceId) devices.delete(token);
      revoked.push(deviceId);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay");
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (url.pathname === "/relay/v1/host") {
        if (bearer(request) !== TEST_HOST_TOKEN) return ws.close(4401, "bad token");
        control?.close(1000, "replaced");
        control = ws;
        ws.send(JSON.stringify({ type: "hello", hostId: TEST_HOST_ID }));
        controlWaiters.splice(0).forEach((resolve) => resolve(ws));
        return;
      }
      if (url.pathname === "/relay/v1/device") {
        const deviceId = devices.get(bearer(request));
        if (deviceId === undefined) return ws.close(4401, "bad token");
        if (control === undefined) return ws.close(4404, "host offline");
        const sessionId = id();
        const entry = { device: ws, queued: [] as Array<Buffer> };
        pending.set(sessionId, entry);
        ws.on("message", (data: Buffer) => entry.queued.push(data));
        control.send(JSON.stringify({ type: "session", sessionId, deviceId }));
        return;
      }
      const match = /^\/relay\/v1\/host\/sessions\/(.+)$/.exec(url.pathname);
      const entry = match ? pending.get(match[1]!) : undefined;
      if (entry === undefined || bearer(request) !== TEST_HOST_TOKEN)
        return ws.close(4404, "unknown");
      pending.delete(match![1]!);
      const { device } = entry;
      device.removeAllListeners("message");
      for (const data of entry.queued) ws.send(data, { binary: true });
      device.on("message", (data: Buffer) => ws.send(data, { binary: true }));
      ws.on("message", (data: Buffer) => device.send(data, { binary: true }));
      // Close codes are passed on so the test can tell why a session ended.
      const passOn = (to: WsSocket) => (code: number, reason: Buffer) =>
        to.close(code >= 3000 && code <= 4999 ? code : 1000, reason.toString());
      device.on("close", passOn(ws));
      ws.on("close", passOn(device));
    });
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    /** Device ids revoked with DELETE /relay/v1/devices/{id}. */
    revoked,
    /** A device token; give `deviceId` to stand in for a relay that kept a revoked device's id. */
    mintDevice: (deviceId = id()) => {
      const deviceToken = `device-token-${deviceId}`;
      devices.set(deviceToken, deviceId);
      return { deviceId, deviceToken };
    },
    nextControl: () => new Promise<WsSocket>((resolve) => controlWaiters.push(resolve)),
    dropControl: () => control?.terminate(),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
