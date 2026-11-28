import type { AuthPairingCredentialResult } from "@t3tools/contracts";
import { type RelayRoute, setRelayRouteOnUrl } from "@t3tools/relay-session/route";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { mintRelayDeviceToken } from "./relayApi.ts";
import {
  loadOrCreateHostKey,
  readRelayConfig,
  recordPairingCode,
  toBase64Url,
} from "./relayStore.ts";

export interface RelayPairingInput {
  readonly stateDir: string;
  /** The link's one-time token; it doubles as the relay pairing code. */
  readonly credential: string;
  readonly expiresAt: number;
  readonly label: string;
  readonly now: number;
  /** The pairing link the credential belongs to, when it is one. */
  readonly pairingLinkId?: string;
}

/** No route when this host has no relay; `note` says why one it has could not be added. */
export interface RelayPairingRoute {
  readonly route?: RelayRoute;
  readonly note?: string;
}

/**
 * When this host is connected to a relay, mints a device token and lets the link's token pair one
 * device through the relay. Never fails: a link without the relay still works directly.
 */
const mintRelayPairingRoute = async (input: RelayPairingInput): Promise<RelayPairingRoute> => {
  try {
    const config = await readRelayConfig(input.stateDir);
    if (config === null) return {};
    if (config.hostId === null) {
      return {
        note: "The relay has not told this computer its host id yet, so this link works only directly.",
      };
    }
    const minted = await mintRelayDeviceToken(config, input.label);
    const hostKey = await loadOrCreateHostKey(input.stateDir);
    await recordPairingCode(
      input.stateDir,
      input.credential,
      {
        deviceId: minted.deviceId,
        label: input.label,
        ...(input.pairingLinkId === undefined ? {} : { pairingLinkId: input.pairingLinkId }),
      },
      { now: input.now, expiresAt: input.expiresAt },
    );
    return {
      route: {
        relayUrl: config.relayUrl,
        hostId: config.hostId,
        hostKey: toBase64Url(hostKey.publicKey),
        deviceToken: minted.deviceToken,
      },
    };
  } catch (cause) {
    return {
      note: `This link works only directly: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

export interface RelayPairing {
  readonly pairingUrl: string;
  readonly viaRelay: boolean;
  readonly note?: string;
}

/** The pairing link with the relay route in its fragment, which never reaches a server log. */
export const addRelayToPairingUrl = async (
  input: RelayPairingInput & { readonly pairingUrl: string },
): Promise<RelayPairing> => {
  const { route, note } = await mintRelayPairingRoute(input);
  return {
    pairingUrl:
      route === undefined ? input.pairingUrl : setRelayRouteOnUrl(input.pairingUrl, route),
    viaRelay: route !== undefined,
    ...(note === undefined ? {} : { note }),
  };
};

/** Adds this server's relay route to a credential that pairs a device; agent approval codes get none. */
export const withRelayRoute = (stateDir: string) =>
  Effect.fn("relay.withRelayRoute")(function* (issued: AuthPairingCredentialResult) {
    if (issued.access !== undefined || issued.purpose !== undefined) return issued;
    const now = yield* Clock.currentTimeMillis;
    const { route, note } = yield* Effect.promise(() =>
      mintRelayPairingRoute({
        stateDir,
        credential: issued.credential,
        expiresAt: DateTime.toEpochMillis(issued.expiresAt),
        label: issued.label ?? "Pairing link",
        now,
        pairingLinkId: issued.id,
      }),
    );
    if (note !== undefined) yield* Effect.logWarning(note);
    return route === undefined ? issued : { ...issued, relay: route };
  });
