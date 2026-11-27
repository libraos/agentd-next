// @effect-diagnostics nodeBuiltinImport:off - an in-process relay on real sockets, for tests.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { WebSocketServer, type WebSocket as WsSocket } from "ws";

export const TEST_HOST_TOKEN = "host-token";
export const TEST_HOST_ID = "0123456789abcdef0123456789abcdef";

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
    mintDevice: () => {
      const deviceId = id();
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
