import {
  type DeviceSocketFactory,
  openRelayTunnel,
  type RelayRequestInit,
  type RelayTunnel,
  RelayTunnelError,
  type RelayTunnelOptions,
  RelayWebSocket,
} from "./device.ts";
import { keyPairFromSecretKey } from "./noise.ts";
import { type RelayRoute, relayHostLabelOfUrl } from "./route.ts";

/** What a device keeps for one host it reaches through the relay; all of it is secret. */
export interface StoredRelayRoute {
  readonly route: RelayRoute;
  /** The device's static X25519 secret key for this host. */
  readonly deviceSecretKey: Uint8Array;
  /** The pairing link's one-time code, kept until the host has let the key in once. */
  readonly pairingCode?: string;
}

export interface RelayRouterOptions {
  readonly load: (hostLabel: string) => Promise<StoredRelayRoute | null>;
  /** The host let this device's key in with its pairing code, so the code is spent. */
  readonly onPaired: (hostLabel: string) => Promise<void> | void;
  /** A tunnel to the host opened. */
  readonly onOpened?: (hostLabel: string) => void;
  /** The relay or the host refused this device (revoked, or no keys): only pairing again helps. */
  readonly onRefused?: (hostLabel: string) => void;
  readonly connect: DeviceSocketFactory;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly tunnel?: Pick<RelayTunnelOptions, "openTimeoutMs" | "heartbeatMs" | "idleCloseMs">;
}

export interface RelayRouter {
  /** `fallback` for every address but the relay's; see relayBaseUrl. */
  readonly fetch: (fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  readonly webSocket: <Socket>(
    fallback: (url: string, protocols?: string | Array<string>) => Socket,
  ) => (url: string, protocols?: string | Array<string>) => Socket | RelayWebSocket;
  /** Ends the tunnel to a host, so the next request reads its keys again. */
  readonly forget: (hostLabel: string) => void;
  readonly closeAll: () => void;
}

// The server's own answer to a refused credential, so a client asks to pair again as it does
// when the server itself refuses this device.
const refusedResponse = () =>
  new Response(
    JSON.stringify({
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "relay-device-refused",
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );

const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * Carries requests for relay addresses through one tunnel per host, opened on first use and
 * again after it ends, and passes every other request to the platform's own transport.
 */
const isRefused = (error: unknown) =>
  error instanceof RelayTunnelError && error.failure === "unauthorized";

export const createRelayRouter = (options: RelayRouterOptions): RelayRouter => {
  const tunnels = new Map<string, Promise<RelayTunnel>>();

  const tunnelFor = (label: string): Promise<RelayTunnel> => {
    const existing = tunnels.get(label);
    if (existing !== undefined) return existing;
    const opening = (async () => {
      const stored = await options.load(label);
      if (stored === null) {
        throw new RelayTunnelError("unauthorized", "This device has no relay keys for that host.");
      }
      const tunnel = await openRelayTunnel({
        route: stored.route,
        deviceKeys: keyPairFromSecretKey(stored.deviceSecretKey),
        ephemeralKeyPair: keyPairFromSecretKey(options.randomBytes(32)),
        ...(stored.pairingCode === undefined ? {} : { pairingCode: stored.pairingCode }),
        connect: options.connect,
        ...options.tunnel,
      });
      if (stored.pairingCode !== undefined) await options.onPaired(label);
      options.onOpened?.(label);
      return tunnel;
    })();
    tunnels.set(label, opening);
    const drop = () => {
      if (tunnels.get(label) === opening) tunnels.delete(label);
    };
    opening.then(
      (tunnel) =>
        tunnel.onClose((failure) => {
          drop();
          if (failure === "unauthorized") options.onRefused?.(label);
        }),
      (error: unknown) => {
        drop();
        if (isRefused(error)) options.onRefused?.(label);
      },
    );
    return opening;
  };

  return {
    fetch: (fallback) => (input, init) => {
      const url = requestUrl(input);
      const label = relayHostLabelOfUrl(url);
      if (label === null) return fallback(input, init);
      const relayInit: RelayRequestInit =
        init ??
        (typeof input === "object" && "method" in input
          ? { method: input.method, headers: input.headers }
          : {});
      return tunnelFor(label).then(
        (tunnel) => tunnel.fetch(url, relayInit),
        (error: unknown) =>
          isRefused(error)
            ? refusedResponse()
            : Promise.reject(new TypeError("Network request failed")),
      );
    },
    webSocket: (fallback) => (url, protocols) => {
      const label = relayHostLabelOfUrl(url);
      return label === null
        ? fallback(url, protocols)
        : new RelayWebSocket(url, protocols, tunnelFor(label));
    },
    forget: (label) => {
      const existing = tunnels.get(label);
      tunnels.delete(label);
      void existing?.then(
        (tunnel) => tunnel.close(),
        () => {},
      );
    },
    closeAll: () => {
      const all = [...tunnels.values()];
      tunnels.clear();
      for (const tunnel of all)
        void tunnel.then(
          (opened) => opened.close(),
          () => {},
        );
    },
  };
};
