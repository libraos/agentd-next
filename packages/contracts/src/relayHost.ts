import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// This computer's relay host, as `lnext relay status|devices|revoke` show and change it.

export const RelayHostDevice = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  /** ISO time it was paired. */
  addedAt: Schema.String,
  /** ISO time it last opened a session through the relay; null when never seen since pairing. */
  lastConnectedAt: Schema.NullOr(Schema.String),
});
export type RelayHostDevice = typeof RelayHostDevice.Type;

export const RelayHostStatus = Schema.Struct({
  /** Null when this computer is not connected to a relay. */
  relay: Schema.NullOr(
    Schema.Struct({
      relayUrl: Schema.String,
      hostId: Schema.NullOr(Schema.String),
      /** Whether the server has its control socket to the relay open. */
      online: Schema.Boolean,
    }),
  ),
  devices: Schema.Array(RelayHostDevice),
});
export type RelayHostStatus = typeof RelayHostStatus.Type;

export const RelayHostRevokeInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type RelayHostRevokeInput = typeof RelayHostRevokeInput.Type;

export const RelayHostRevokeResult = Schema.Struct({
  keyRemoved: Schema.Boolean,
  /** Null when the relay revoked the device's token or none is connected; else why it did not. */
  relayFailure: Schema.NullOr(Schema.String),
  status: RelayHostStatus,
});
export type RelayHostRevokeResult = typeof RelayHostRevokeResult.Type;

export class RelayHostError extends Schema.TaggedError<RelayHostError>()("RelayHostError", {
  message: Schema.String,
}) {}
