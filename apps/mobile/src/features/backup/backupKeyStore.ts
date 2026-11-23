import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { ageKeyPairFromIdentity, ageKeyPairFromSecret, type AgeKeyPair } from "./ageKey";

/**
 * This device's agentd backup key. One key for every computer this device backs up: the private
 * half stays in the system keychain or keystore and never leaves the device except when the person
 * writes it down; computers only ever get the public half.
 */
export const BACKUP_IDENTITY_KEY = "agentd.backup.age-identity";

export class BackupKeyError extends Schema.TaggedError<BackupKeyError>()("BackupKeyError", {
  reason: Schema.Literals(["unreadable", "corrupt"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "corrupt"
      ? "The backup key saved on this device is damaged. Backups made with it need the key you wrote down."
      : "The backup key could not be read from this device's secure storage.";
  }
}

export interface BackupKey extends AgeKeyPair {
  /** True only when this call made the key: the one time to show the private key to the person. */
  readonly created: boolean;
}

/** The saved key, or null when this device has none yet. A damaged key is an error, never replaced. */
export const loadBackupKey = Effect.gen(function* () {
  const storage = yield* MobileSecureStorage;
  const saved = yield* storage
    .getItem(BACKUP_IDENTITY_KEY)
    .pipe(Effect.mapError((cause) => new BackupKeyError({ reason: "unreadable", cause })));
  if (saved === null) return null;
  const pair = ageKeyPairFromIdentity(saved);
  if (pair === null) return yield* new BackupKeyError({ reason: "corrupt" });
  return pair;
});

/** The saved key, making and saving one first if this device has none. */
export const ensureBackupKey = Effect.fn("BackupKeyStore.ensureBackupKey")(function* (
  randomBytes: (length: number) => Uint8Array,
) {
  const existing = yield* loadBackupKey;
  if (existing !== null) return { ...existing, created: false } satisfies BackupKey;
  const storage = yield* MobileSecureStorage;
  const pair = ageKeyPairFromSecret(randomBytes(32));
  yield* storage
    .setItem(BACKUP_IDENTITY_KEY, pair.identity)
    .pipe(Effect.mapError((cause) => new BackupKeyError({ reason: "unreadable", cause })));
  return { ...pair, created: true } satisfies BackupKey;
});
