// @effect-diagnostics globalTimers:off globalDate:off globalRandom:off - socket callbacks outside Effect; relayHostLayer.ts owns the lifetime.
import { Multiplexer } from "@t3tools/relay-session/mux";
import type { KeyPair } from "@t3tools/relay-session/noise";
import {
  type HandshakeClaims,
  SecureSession,
  SessionCloseCode,
} from "@t3tools/relay-session/session";
import { WebSocket } from "undici";

import { forwardHttpStream, forwardWsStream, type LoopbackTarget } from "./loopbackForward.ts";
import { RELAY_SUBPROTOCOL, relayAuthHeaders, relayEndpoint } from "./relayApi.ts";
import {
  addRelayDevice,
  consumePairingCode,
  listRelayDevices,
  loadOrCreateHostKey,
  readRelayConfig,
  type RelayConfig,
  toBase64Url,
  writeRelayConfig,
} from "./relayStore.ts";

export type RelayHostLog = (
  level: "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface RelayHostOptions {
  readonly stateDir: string;
  readonly target: LoopbackTarget;
  readonly log?: RelayHostLog;
  /** Reconnect delays after the control socket closes; doubled up to maxMs. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  /** How often the relay settings and paired devices are reread. */
  readonly pollMs?: number;
  readonly now?: () => number;
}

export interface RelayHost {
  /** Whether the control socket is open. */
  readonly connected: () => boolean;
  readonly stop: () => Promise<void>;
}

/** Messages the relay sends on the control socket. */
type ControlMessage =
  | { readonly type: "hello"; readonly hostId: string }
  | { readonly type: "session"; readonly sessionId: string; readonly deviceId: string };

const parseControlMessage = (data: string): ControlMessage | null => {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (value.type === "hello" && typeof value.hostId === "string" && value.hostId.length > 0) {
      return { type: "hello", hostId: value.hostId };
    }
    if (
      value.type === "session" &&
      typeof value.sessionId === "string" &&
      typeof value.deviceId === "string"
    ) {
      return { type: "session", sessionId: value.sessionId, deviceId: value.deviceId };
    }
  } catch {
    // Not JSON: ignored like any message this version does not know.
  }
  return null;
};

/**
 * Admits a device whose key is paired with this device id, or one that brings an unused pairing
 * code minted for it; that pairs its key.
 */
const authorizeRelayDevice = async (input: {
  readonly stateDir: string;
  readonly deviceId: string;
  readonly deviceKey: Uint8Array;
  readonly claims: HandshakeClaims;
  readonly now: number;
}): Promise<boolean> => {
  const publicKey = toBase64Url(input.deviceKey);
  const devices = await listRelayDevices(input.stateDir);
  if (devices.some((entry) => entry.publicKey === publicKey && entry.deviceId === input.deviceId)) {
    return true;
  }
  if (input.claims.pairing === undefined) return false;
  const grant = await consumePairingCode(
    input.stateDir,
    input.claims.pairing,
    input.deviceId,
    input.now,
  );
  if (grant === null) return false;
  await addRelayDevice(input.stateDir, {
    deviceId: input.deviceId,
    publicKey,
    label: grant.label,
    addedAt: new Date(input.now).toISOString(),
  });
  return true;
};

interface OpenSession {
  readonly session: SecureSession;
  deviceKey: string | undefined;
}

/** Keeps the control socket to the relay open and serves each session it announces. */
export const startRelayHost = (options: RelayHostOptions): RelayHost => {
  const log: RelayHostLog = options.log ?? (() => {});
  const backoff = options.backoff ?? { initialMs: 1_000, maxMs: 60_000 };
  const pollMs = options.pollMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sessions = new Set<OpenSession>();
  let stopped = false;
  let control: WebSocket | undefined;
  let controlOpen = false;
  let wake: (() => void) | undefined;
  let endControl: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  const closeRevokedSessions = async () => {
    const paired = new Set((await listRelayDevices(options.stateDir)).map((d) => d.publicKey));
    for (const entry of sessions) {
      if (entry.deviceKey !== undefined && !paired.has(entry.deviceKey)) {
        entry.session.close(SessionCloseCode.NOT_AUTHORIZED, "device revoked");
      }
    }
  };

  const openSession = (
    config: RelayConfig,
    hostKey: KeyPair,
    hostId: string,
    message: { readonly sessionId: string; readonly deviceId: string },
  ) => {
    const socket = new WebSocket(
      relayEndpoint(
        config.relayUrl,
        `/relay/v1/host/sessions/${encodeURIComponent(message.sessionId)}`,
        true,
      ),
      { protocols: [RELAY_SUBPROTOCOL], headers: relayAuthHeaders(config) },
    );
    socket.binaryType = "arraybuffer";
    let mux: Multiplexer | undefined;
    const session = SecureSession.responder({
      transport: {
        send: (data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close: (code, reason) => socket.close(code, reason),
      },
      hostId,
      staticKeyPair: hostKey,
      authorize: (deviceKey, claims) =>
        authorizeRelayDevice({
          stateDir: options.stateDir,
          deviceId: message.deviceId,
          deviceKey,
          claims,
          now: now(),
        }).catch((cause: unknown) => {
          log("warn", "Relay device check failed", { cause: String(cause) });
          return false;
        }),
      onOpen: (opened) => {
        entry.deviceKey = toBase64Url(opened.remoteStaticKey!);
        mux = new Multiplexer({
          role: "host",
          send: (frame) => opened.send(frame),
          onHttpStream: (stream, open) => forwardHttpStream(options.target, stream, open),
          onWsStream: (stream, open) => forwardWsStream(options.target, stream, open),
        });
      },
      onMessage: (plaintext) => mux?.receive(plaintext),
      onClose: () => {
        mux?.close();
        sessions.delete(entry);
      },
    });
    const entry: OpenSession = { session, deviceKey: undefined };
    sessions.add(entry);
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        session.close(SessionCloseCode.PROTOCOL_ERROR, "text message");
        return;
      }
      session.receive(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", () => session.close(SessionCloseCode.NORMAL, "closed"));
  };

  /** Resolves when the control socket closes or the relay settings change. */
  const runControl = (config: RelayConfig, hostKey: KeyPair) =>
    new Promise<{ readonly opened: boolean; readonly code?: number }>((resolve) => {
      let current = config;
      let opened = false;
      let ended = false;
      const socket = new WebSocket(relayEndpoint(config.relayUrl, "/relay/v1/host", true), {
        protocols: [RELAY_SUBPROTOCOL],
        headers: relayAuthHeaders(config),
      });
      control = socket;
      const finish = (code?: number) => {
        if (ended) return;
        ended = true;
        clearInterval(poll);
        controlOpen = false;
        control = undefined;
        endControl = undefined;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        resolve(code === undefined ? { opened } : { opened, code });
      };
      endControl = () => finish();
      const poll = setInterval(() => {
        void readRelayConfig(options.stateDir)
          .then((next) => {
            if (JSON.stringify(next) !== JSON.stringify(current)) finish();
          })
          .then(closeRevokedSessions)
          .catch(() => {});
      }, pollMs);
      socket.addEventListener("open", () => {
        opened = true;
        controlOpen = true;
        log("info", "Connected to the relay", { relay: config.relayUrl });
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const message = parseControlMessage(event.data);
        if (message?.type === "hello" && message.hostId !== current.hostId) {
          current = { ...current, hostId: message.hostId };
          void writeRelayConfig(options.stateDir, current).catch((cause: unknown) =>
            log("warn", "Could not save the relay host id", { cause: String(cause) }),
          );
        } else if (message?.type === "session") {
          if (current.hostId === null) {
            log("warn", "Relay session refused: this host has no host id yet");
            return;
          }
          openSession(current, hostKey, current.hostId, message);
        }
      });
      socket.addEventListener("close", (event) => finish(event.code));
    });

  const isStopped = () => stopped;
  const run = async () => {
    let delay = backoff.initialMs;
    while (!isStopped()) {
      let config: RelayConfig | null = null;
      try {
        config = await readRelayConfig(options.stateDir);
      } catch (cause) {
        log("warn", "Could not read the relay settings", { cause: String(cause) });
      }
      if (config === null) {
        await sleep(pollMs);
        continue;
      }
      const hostKey = await loadOrCreateHostKey(options.stateDir);
      const outcome = await runControl(config, hostKey);
      if (isStopped()) break;
      if (outcome.opened) delay = backoff.initialMs;
      if (outcome.code === undefined) continue;
      // 4401 and 4403: the token is bad or revoked; retry slowly until the settings change.
      const wait = outcome.code === 4401 || outcome.code === 4403 ? backoff.maxMs : delay;
      log("warn", "Relay connection closed; reconnecting", { code: outcome.code, delayMs: wait });
      await sleep(Math.round(wait * (0.8 + Math.random() * 0.4)));
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  };

  const done = run().catch((cause: unknown) =>
    log("warn", "The relay host stopped", { cause: String(cause) }),
  );

  return {
    connected: () => controlOpen,
    stop: async () => {
      stopped = true;
      wake?.();
      endControl?.();
      control?.close();
      for (const entry of sessions) entry.session.close(SessionCloseCode.NORMAL, "host stopping");
      await done;
    },
  };
};
