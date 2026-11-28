import * as Effect from "effect/Effect";

import type * as SessionStore from "../../auth/SessionStore.ts";
import { revokeRelayKeysExceptSession, revokeRelayKeysOfSessions } from "./relayDevices.ts";
import { linkRelaySession, removePairingCodesOfLink } from "./relayStore.ts";

// The request already did what it was asked; a relay file that cannot be written is only logged.
const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.promise(() =>
    run().then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause: String(cause) }),
    ),
  ).pipe(
    Effect.tap((outcome) =>
      outcome.ok ? Effect.void : Effect.logWarning(what, { cause: outcome.cause }),
    ),
  );

const logRevoked = (
  results: ReadonlyArray<{
    readonly deviceId: string;
    readonly atRelay: { readonly kind: string };
  }>,
) =>
  results.length === 0
    ? Effect.void
    : Effect.logInfo("Revoked relay keys with their sessions", {
        devices: results.map((result) => `${result.deviceId} (${result.atRelay.kind})`),
      });

/**
 * Ties the auth handlers to the relay keys: a session made with a relay pairing code is remembered
 * with it, and revoking that session revokes the key it paired. None of these fail the request.
 */
export const makeRelayAuthHooks = (
  stateDir: string,
  sessions: SessionStore.SessionStore["Service"],
) => ({
  /** After `credential` was traded for the session `token`. */
  linkSession: (credential: string, token: string) =>
    sessions.verify(token).pipe(
      Effect.flatMap((session) =>
        attempt("Could not link the session to its relay key", () =>
          linkRelaySession(stateDir, credential, session.sessionId),
        ),
      ),
      Effect.ignore,
    ),
  revokedSessions: (sessionIds: ReadonlyArray<string>) =>
    attempt("Could not revoke the relay keys of revoked sessions", () =>
      revokeRelayKeysOfSessions(stateDir, sessionIds),
    ).pipe(Effect.flatMap((results) => (results.ok ? logRevoked(results.value) : Effect.void))),
  revokedOtherSessions: (keptSessionId: string) =>
    attempt("Could not revoke the relay keys of revoked sessions", () =>
      revokeRelayKeysExceptSession(stateDir, keptSessionId),
    ).pipe(Effect.flatMap((results) => (results.ok ? logRevoked(results.value) : Effect.void))),
  revokedPairingLink: (pairingLinkId: string) =>
    attempt("Could not drop the revoked link's relay pairing code", () =>
      removePairingCodesOfLink(stateDir, pairingLinkId),
    ).pipe(Effect.asVoid),
});
