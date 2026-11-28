// @effect-diagnostics nodeBuiltinImport:off - a local server on real sockets behind the test relay.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Multiplexer, type MuxStream, type StreamEvent } from "@t3tools/relay-session/mux";
import { generateKeyPair, type KeyPair } from "@t3tools/relay-session/noise";
import { SecureSession, SessionCloseCode } from "@t3tools/relay-session/session";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { WebSocket } from "undici";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";

import { startRelayHost, type RelayHost } from "./relayHost.ts";
import { addRelayToPairingUrl, withRelayRoute } from "./relayPairing.ts";
import { listen, startTestRelay, TEST_HOST_ID, TEST_HOST_TOKEN } from "./testRelay.ts";
import {
  listRelayDevices,
  loadOrCreateHostKey,
  readRelayConfig,
  recordPairingCode,
  removeRelayDevice,
  writeRelayConfig,
} from "./relayStore.ts";

const HOST_TOKEN = TEST_HOST_TOKEN;
const EPOCH = Date.UTC(2026, 0, 1);
const HOST_ID = TEST_HOST_ID;

/** The server the relay host forwards to: it echoes requests and WebSocket messages. */
const startLocalServer = async () => {
  const requests: Array<{ method: string; url: string; headers: NodeHttp.IncomingHttpHeaders }> =
    [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push({ method: request.method!, url: request.url!, headers: request.headers });
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/octet-stream", "x-echo": "yes" });
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

interface DeviceConnection {
  readonly mux: Multiplexer;
  readonly session: SecureSession;
  readonly closed: Promise<number>;
}

const connectDevice = (input: {
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
      `${input.relayUrl.replace("http", "ws")}/relay/v1/device?host=${HOST_ID}`,
      { headers: { authorization: `Bearer ${input.deviceToken}` } },
    );
    socket.binaryType = "arraybuffer";
    let resolveClosed: (code: number) => void = () => {};
    const closed = new Promise<number>((done) => (resolveClosed = done));
    let mux: Multiplexer | undefined;
    socket.addEventListener("open", () => {
      const session = SecureSession.initiator({
        transport: { send: (data) => socket.send(data), close: (code) => socket.close(code) },
        hostId: HOST_ID,
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

const collect = (stream: MuxStream) => {
  const events: Array<StreamEvent> = [];
  const waiters: Array<{ match: (event: StreamEvent) => boolean; resolve: () => void }> = [];
  stream.onEvent = (event) => {
    events.push(event);
    if (event.type === "data" || event.type === "text" || event.type === "binary") {
      stream.release(event.credit);
    }
    for (const waiter of waiters.filter((entry) => entry.match(event))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const until = (match: (event: StreamEvent) => boolean) =>
    events.some(match)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ match, resolve }));
  return { events, until };
};

describe("relay host", () => {
  let stateDir: string;
  let relay: Awaited<ReturnType<typeof startTestRelay>>;
  let local: Awaited<ReturnType<typeof startLocalServer>>;
  let host: RelayHost | undefined;
  let hostKey: KeyPair;

  const startHost = async (options: { readonly now?: () => number } = {}) => {
    const connected = relay.nextControl();
    host = startRelayHost({
      stateDir,
      target: { host: "127.0.0.1", port: local.port },
      backoff: { initialMs: 10, maxMs: 50 },
      pollMs: 50,
      now: options.now ?? (() => EPOCH),
    });
    await connected;
  };

  const pairingDevice = async (code: string, options: { readonly expiresAt?: number } = {}) => {
    const minted = relay.mintDevice();
    await recordPairingCode(
      stateDir,
      code,
      { deviceId: minted.deviceId, label: "phone" },
      { now: EPOCH, ...options },
    );
    return minted;
  };

  beforeEach(async () => {
    stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-host-"));
    relay = await startTestRelay();
    local = await startLocalServer();
    await writeRelayConfig(stateDir, { relayUrl: relay.url, token: HOST_TOKEN, hostId: null });
    hostKey = await loadOrCreateHostKey(stateDir);
  });

  afterEach(async () => {
    await host?.stop();
    host = undefined;
    await relay.close();
    await local.close();
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });

  it("carries HTTP requests with bodies and WebSocket messages intact, on loopback", async () => {
    await startHost();
    const minted = await pairingDevice("code-1");
    const device = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-1",
    });

    // Larger than the initial window, so credit must come back for it to arrive.
    const body = new Uint8Array(600 * 1024).map((_, index) => index % 251);
    const request = device.mux.openHttp({
      method: "POST",
      path: "/echo?x=1",
      headers: { "content-type": "application/octet-stream", "x-forwarded-for": "203.0.113.9" },
    });
    const response = collect(request);
    request.write(body);
    request.end();
    await response.until((event) => event.type === "end");
    const head = response.events.find((event) => event.type === "head");
    expect(head?.type === "head" && head.head.status).toBe(201);
    expect(head?.type === "head" && head.head.headers["x-echo"]).toBe("yes");
    const received = Buffer.concat(
      response.events.flatMap((event) => (event.type === "data" ? [event.data] : [])),
    );
    expect(received.equals(Buffer.from(body))).toBe(true);
    const seen = local.requests[0]!;
    expect(seen).toMatchObject({ method: "POST", url: "/echo?x=1" });
    // Presented as a local TLS proxy would, so DPoP proofs for the relay address verify.
    expect(seen.headers.host).toBe(`${HOST_ID}.relay.invalid`);
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();

    const ws = device.mux.openWs({ path: "/ws", headers: {}, protocols: [] });
    const wsEvents = collect(ws);
    await wsEvents.until((event) => event.type === "accept");
    const big = "y".repeat(200 * 1024);
    ws.sendText(big);
    ws.sendBinary(Uint8Array.of(1, 2, 3));
    await wsEvents.until((event) => event.type === "binary");
    const messages = wsEvents.events.filter(
      (event) => event.type === "text" || event.type === "binary",
    );
    expect(messages[0]?.type === "text" && messages[0].text).toBe(big);
    expect(messages[1]?.type === "binary" && [...messages[1].data]).toEqual([1, 2, 3]);

    expect((await listRelayDevices(stateDir)).map((entry) => entry.label)).toEqual(["phone"]);
    expect((await readRelayConfig(stateDir))?.hostId).toBe(HOST_ID);
  });

  it("refuses an unpaired device without a pairing code before any byte reaches the server", async () => {
    await startHost();
    const minted = relay.mintDevice();
    const attempt = connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      sendAtOnce: (mux) => {
        const stream = mux.openHttp({ method: "POST", path: "/echo", headers: {} });
        stream.write(Uint8Array.of(1));
        stream.end();
      },
    });
    const opened = await attempt;
    expect(await opened.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
    expect(local.requests).toEqual([]);
    expect(await listRelayDevices(stateDir)).toEqual([]);
  });

  it("refuses a pairing code that was used or has expired", async () => {
    let clock = EPOCH;
    await startHost({ now: () => clock });
    const minted = await pairingDevice("code-used");
    const first = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-used",
    });
    // The host answers only once it has let the device in.
    await first.mux.ping();
    const reused = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-used",
    });
    expect(await reused.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);

    const late = await pairingDevice("code-late");
    clock += 11 * 60 * 1000;
    const expired = await connectDevice({
      relayUrl: relay.url,
      deviceToken: late.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-late",
    });
    expect(await expired.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
    expect(await listRelayDevices(stateDir)).toHaveLength(1);
  });

  it("lets a paired device back in without a code, and cuts it off once revoked", async () => {
    await startHost();
    const minted = await pairingDevice("code-2");
    const deviceKeys = generateKeyPair();
    const first = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys,
      hostKey: hostKey.publicKey,
      pairingCode: "code-2",
    });
    await first.mux.ping();
    first.session.close();
    const again = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys,
      hostKey: hostKey.publicKey,
    });
    await again.mux.ping();
    await removeRelayDevice(stateDir, minted.deviceId);
    expect(await again.closed).toBe(SessionCloseCode.NOT_AUTHORIZED);
  });

  it("fails the handshake for a device that holds another host key", async () => {
    await startHost();
    const minted = await pairingDevice("code-3");
    const attempt = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: generateKeyPair().publicKey,
      pairingCode: "code-3",
    }).catch((error: unknown) => error);
    expect(attempt).toBeInstanceOf(Error);
    expect(await listRelayDevices(stateDir)).toEqual([]);
  });

  it("puts relay, host, hk and dt in the pairing link's fragment, and its token pairs once", async () => {
    await writeRelayConfig(stateDir, { relayUrl: relay.url, token: HOST_TOKEN, hostId: HOST_ID });
    await startHost();
    const issuedAt = EPOCH;
    const pairing = await addRelayToPairingUrl({
      stateDir,
      pairingUrl: "http://computer.example:3773/pair#token=one-time",
      credential: "one-time",
      expiresAt: issuedAt + 5 * 60 * 1000,
      label: "My phone",
      now: issuedAt,
    });
    expect(pairing).toMatchObject({ viaRelay: true });
    const url = new URL(pairing.pairingUrl);
    expect(url.search).toBe("");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("token")).toBe("one-time");
    expect(fragment.get("relay")).toBe(relay.url);
    expect(fragment.get("host")).toBe(HOST_ID);
    expect(fragment.get("hk")).toBe(Buffer.from(hostKey.publicKey).toString("base64url"));

    const device = await connectDevice({
      relayUrl: fragment.get("relay")!,
      deviceToken: fragment.get("dt")!,
      deviceKeys: generateKeyPair(),
      hostKey: new Uint8Array(Buffer.from(fragment.get("hk")!, "base64url")),
      pairingCode: fragment.get("token")!,
    });
    await device.mux.ping();
    expect((await listRelayDevices(stateDir)).map((entry) => entry.label)).toEqual(["My phone"]);
  });

  effectIt.effect(
    "gives a device pairing credential the relay route, and an agent approval code none",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(EPOCH);
        yield* Effect.promise(() =>
          writeRelayConfig(stateDir, { relayUrl: relay.url, token: HOST_TOKEN, hostId: HOST_ID }),
        );
        const issued = {
          id: "link-1",
          credential: "settings-code",
          expiresAt: DateTime.makeUnsafe(EPOCH + 5 * 60 * 1000),
        };
        const routed = yield* withRelayRoute(stateDir)(issued);
        expect(routed.relay).toMatchObject({
          relayUrl: relay.url,
          hostId: HOST_ID,
          hostKey: Buffer.from(hostKey.publicKey).toString("base64url"),
        });
        const approval = yield* withRelayRoute(stateDir)({
          ...issued,
          credential: "approval",
          access: "read-only",
        });
        expect(approval.relay).toBeUndefined();

        yield* Effect.promise(async () => {
          await startHost();
          const device = await connectDevice({
            relayUrl: relay.url,
            deviceToken: routed.relay!.deviceToken,
            deviceKeys: generateKeyPair(),
            hostKey: hostKey.publicKey,
            pairingCode: "settings-code",
          });
          await device.mux.ping();
        });
      }),
  );

  it("leaves the pairing link direct when no relay is connected", async () => {
    await NodeFSP.rm(NodePath.join(stateDir, "relay", "relay.json"));
    const pairing = await addRelayToPairingUrl({
      stateDir,
      pairingUrl: "http://computer.example:3773/pair#token=one-time",
      credential: "one-time",
      expiresAt: EPOCH + 60_000,
      label: "phone",
      now: EPOCH,
    });
    expect(pairing).toEqual({
      pairingUrl: "http://computer.example:3773/pair#token=one-time",
      viaRelay: false,
    });
  });

  it("reconnects the control socket after the relay drops it", async () => {
    await startHost();
    const reconnected = relay.nextControl();
    relay.dropControl();
    await reconnected;
    const minted = await pairingDevice("code-4");
    const device = await connectDevice({
      relayUrl: relay.url,
      deviceToken: minted.deviceToken,
      deviceKeys: generateKeyPair(),
      hostKey: hostKey.publicKey,
      pairingCode: "code-4",
    });
    await device.mux.ping();
  });
});
