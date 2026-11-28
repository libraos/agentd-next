// @effect-diagnostics nodeBuiltinImport:off - a phone's relay transport against the test relay and a real relay host.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DeviceSocket } from "@t3tools/relay-session/device";
import { createRelayRouter, type StoredRelayRoute } from "@t3tools/relay-session/deviceRouter";
import {
  readRelayRouteFromUrl,
  relayBaseUrl,
  relayHostLabel,
  type RelayRoute,
} from "@t3tools/relay-session/route";
import { WebSocket } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";

import { startRelayHost, type RelayHost } from "./relayHost.ts";
import { addRelayToPairingUrl } from "./relayPairing.ts";
import { listen, startTestRelay, TEST_HOST_ID, TEST_HOST_TOKEN } from "./testRelay.ts";
import { listRelayDevices, removeRelayDevice, writeRelayConfig } from "./relayStore.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const LABEL = relayHostLabel(TEST_HOST_ID)!;

const startLocalServer = async () => {
  const requests: Array<{ method: string; url: string; headers: NodeHttp.IncomingHttpHeaders }> =
    [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push({ method: request.method!, url: request.url!, headers: request.headers });
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(201, { "content-type": "text/plain", "x-echo": "yes" });
      response.end(Buffer.concat(chunks));
    });
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, request) => {
    requests.push({ method: "WS", url: request.url!, headers: request.headers });
    ws.on("message", (data: Buffer, isBinary) => ws.send(isBinary ? data : data.toString()));
  });
  const port = await listen(server);
  return {
    port,
    requests,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

// What a phone's keychain holds, in memory.
const memoryKeychain = () => {
  const entries = new Map<string, StoredRelayRoute>();
  return {
    entries,
    load: async (label: string) => entries.get(label) ?? null,
    onPaired: (label: string) => {
      const stored = entries.get(label);
      if (stored !== undefined) {
        entries.set(label, { route: stored.route, deviceSecretKey: stored.deviceSecretKey });
      }
    },
  };
};

const connect = (url: string, protocols: ReadonlyArray<string>, headers: Record<string, string>) =>
  new WebSocket(url, { protocols: [...protocols], headers }) as unknown as DeviceSocket;

const randomBytes = (length: number) => new Uint8Array(NodeCrypto.randomBytes(length));

describe("phone relay transport", () => {
  let stateDir: string;
  let relay: Awaited<ReturnType<typeof startTestRelay>>;
  let local: Awaited<ReturnType<typeof startLocalServer>>;
  let host: RelayHost | undefined;
  let route: RelayRoute;
  let keychain: ReturnType<typeof memoryKeychain>;
  let router: ReturnType<typeof createRelayRouter>;
  const refused: Array<string> = [];

  beforeEach(async () => {
    stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-phone-"));
    relay = await startTestRelay();
    local = await startLocalServer();
    await writeRelayConfig(stateDir, {
      relayUrl: relay.url,
      token: TEST_HOST_TOKEN,
      hostId: TEST_HOST_ID,
    });
    const connected = relay.nextControl();
    host = startRelayHost({
      stateDir,
      target: { host: "127.0.0.1", port: local.port },
      backoff: { initialMs: 10, maxMs: 50 },
      pollMs: 50,
      now: () => EPOCH,
    });
    await connected;
    const pairing = await addRelayToPairingUrl({
      stateDir,
      pairingUrl: `http://192.0.2.1:3773/pair#token=one-time`,
      credential: "one-time",
      expiresAt: EPOCH + 5 * 60 * 1000,
      label: "My phone",
      now: EPOCH,
    });
    route = readRelayRouteFromUrl(pairing.pairingUrl)!;
    keychain = memoryKeychain();
    keychain.entries.set(LABEL, {
      route,
      deviceSecretKey: randomBytes(32),
      pairingCode: "one-time",
    });
    refused.length = 0;
    router = createRelayRouter({
      load: keychain.load,
      onPaired: keychain.onPaired,
      onRefused: (label) => refused.push(label),
      connect,
      randomBytes,
    });
  });

  afterEach(async () => {
    router.closeAll();
    await host?.stop();
    host = undefined;
    await relay.close();
    await local.close();
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });

  it("pairs its key with the link's code on first contact, then carries HTTP through the relay", async () => {
    const direct = vi.fn(async () => new Response("direct"));
    const relayFetch = router.fetch(direct);

    const response = await relayFetch(new URL("echo?x=1", relayBaseUrl(route)), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello host",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-echo")).toBe("yes");
    expect(await response.text()).toBe("hello host");
    expect(direct).not.toHaveBeenCalled();
    const seen = local.requests.at(-1)!;
    expect(seen).toMatchObject({ method: "POST", url: "/echo?x=1" });
    // The relay address the phone signed DPoP proofs for is the one the server sees.
    expect(seen.headers.host).toBe(`${LABEL}.relay.invalid`);
    expect(await listRelayDevices(stateDir)).toHaveLength(1);
    expect(keychain.entries.get(LABEL)?.pairingCode).toBeUndefined();
  });

  it("keeps every other address on the platform's own transport", async () => {
    const direct = vi.fn(async () => new Response("direct"));
    const response = await router.fetch(direct)("http://192.0.2.1:3773/.well-known/t3/environment");
    expect(await response.text()).toBe("direct");
    expect(direct).toHaveBeenCalledOnce();
  });

  it("opens WebSockets to the host through the relay", async () => {
    const fallback = vi.fn((_url: string): never => {
      throw new Error("not a relay address");
    });
    const socket = router.webSocket(fallback)(
      `${relayBaseUrl(route).replace("https", "wss")}ws?ticket=abc`,
      ["rpc"],
    );
    const opened = new Promise((resolve) => socket.addEventListener("open", resolve));
    await opened;
    const echoed = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data)),
    );
    socket.send("ping");
    expect(await echoed).toBe("ping");
    const closed = new Promise<unknown>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.close(1000);
    expect(await closed).toBe(1000);
    expect(fallback).not.toHaveBeenCalled();
    expect(local.requests.find((request) => request.method === "WS")?.url).toBe("/ws?ticket=abc");
  });

  it("comes back without the spent code once paired", async () => {
    const relayFetch = router.fetch(fetch);
    expect((await relayFetch(new URL("first", relayBaseUrl(route)))).status).toBe(201);
    router.forget(LABEL);
    expect((await relayFetch(new URL("second", relayBaseUrl(route)))).status).toBe(201);
    expect(local.requests.map((request) => request.url)).toEqual(["/first", "/second"]);
  });

  it("answers as a refused sign-in once the host revokes the phone, so the app asks to pair again", async () => {
    const relayFetch = router.fetch(fetch);
    expect((await relayFetch(new URL("first", relayBaseUrl(route)))).status).toBe(201);
    const [device] = await listRelayDevices(stateDir);
    await removeRelayDevice(stateDir, device!.deviceId);
    await vi.waitFor(() => expect(refused).toEqual([LABEL]));

    const response = await relayFetch(new URL("again", relayBaseUrl(route)));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ _tag: "EnvironmentAuthInvalidError" });
    expect(local.requests.map((request) => request.url)).toEqual(["/first"]);
  });

  it("answers as a refused sign-in when the relay no longer knows the phone's token", async () => {
    const stored = keychain.entries.get(LABEL)!;
    keychain.entries.set(LABEL, { ...stored, route: { ...route, deviceToken: "revoked" } });
    const response = await router.fetch(fetch)(new URL("x", relayBaseUrl(route)));
    expect(response.status).toBe(401);
    expect(refused).toEqual([LABEL]);
  });

  it("fails like an unreachable address when the relay is down", async () => {
    await relay.close();
    await expect(router.fetch(fetch)(new URL("x", relayBaseUrl(route)))).rejects.toThrow(TypeError);
    expect(refused).toEqual([]);
  });
});
