import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";
import { AGE_IDENTITY } from "./ageKey";
import { BACKUP_IDENTITY_KEY, ensureBackupKey, loadBackupKey } from "./backupKeyStore";

function storageLayer(values: Map<string, string>) {
  return Layer.succeed(
    MobileSecureStorage.MobileSecureStorage,
    MobileSecureStorage.MobileSecureStorage.of({
      getItem: (key) => Effect.sync(() => values.get(key) ?? null),
      setItem: (key, value) => Effect.sync(() => void values.set(key, value)),
      removeItem: (key) => Effect.sync(() => void values.delete(key)),
    }),
  );
}

const random = (length: number) => Uint8Array.from({ length }, (_, index) => index + 3);

describe("backup key store", () => {
  it.effect("makes the key once, then gives back the same key without showing it again", () => {
    const values = new Map<string, string>();
    return Effect.gen(function* () {
      expect(yield* loadBackupKey).toBeNull();
      const first = yield* ensureBackupKey(random);
      expect(first.created).toBe(true);
      expect(values.get(BACKUP_IDENTITY_KEY)).toBe(first.identity);
      expect(first.identity).toMatch(AGE_IDENTITY);

      const again = yield* ensureBackupKey(() => new Uint8Array(32).fill(1));
      expect(again).toEqual({ ...first, created: false });
      expect(yield* loadBackupKey).toEqual({
        recipient: first.recipient,
        identity: first.identity,
      });
    }).pipe(Effect.provide(storageLayer(values)));
  });

  it.effect("never replaces a damaged key, since older backups need it", () => {
    const values = new Map([[BACKUP_IDENTITY_KEY, "AGE-SECRET-KEY-1NOTAKEY"]]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(ensureBackupKey(random));
      expect(error.reason).toBe("corrupt");
      expect(values.get(BACKUP_IDENTITY_KEY)).toBe("AGE-SECRET-KEY-1NOTAKEY");
    }).pipe(Effect.provide(storageLayer(values)));
  });
});
