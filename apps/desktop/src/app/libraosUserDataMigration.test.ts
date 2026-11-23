import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import { copyLegacyUserData } from "./libraosUserDataMigration.ts";

const posix = HostProcess.Platform.defaultValue() !== "win32";

/** Every entry under a directory with its contents and mode, without following links. */
const snapshot = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(directory);
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(directory, entry.name);
        const name = `${prefix}${entry.name}`;
        if (entry.type === "Directory") {
          files[`${name}/`] = "dir";
          yield* walk(full, `${name}/`);
        } else if (entry.type === "SymbolicLink") {
          files[name] = `-> ${yield* fs.readLink(full)}`;
        } else {
          const mode = ((yield* fs.lstat(full)).mode & 0o777).toString(8);
          files[name] = `${yield* fs.readFileString(full)} (${mode})`;
        }
      }
    });
  yield* walk(root, "");
  return files;
});

const makeLegacyProfile = Effect.fn(function* (appData: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacy = path.join(appData, name);
  yield* fs.makeDirectory(path.join(legacy, "Local Storage", "leveldb"), { recursive: true });
  yield* fs.writeFileString(path.join(legacy, "Local Storage", "leveldb", "000003.log"), "tokens");
  yield* fs.chmod(path.join(legacy, "Local Storage", "leveldb", "000003.log"), 0o600);
  yield* fs.writeFileString(path.join(legacy, "Preferences"), "{}");
  yield* fs.makeDirectory(path.join(legacy, "GPUCache"));
  yield* fs.writeFileString(path.join(legacy, "GPUCache", "data_0"), "shaders");
  return legacy;
});

it.layer(NodeServices.layer)("copyLegacyUserData", (it) => {
  it.effect.each([
    { isDevelopment: false, legacyName: "agentd-desktop", name: "libraos-next" },
    { isDevelopment: true, legacyName: "agentd-desktop-dev", name: "libraos-next-dev" },
  ])(
    "copies $legacyName to $name on first start and leaves it untouched",
    ({ isDevelopment, legacyName, name }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
        const legacy = yield* makeLegacyProfile(appData, legacyName);
        const before = yield* snapshot(legacy);

        const result = copyLegacyUserData({ appDataDirectory: appData, isDevelopment });

        const target = path.join(appData, name);
        assert.deepInclude(result, { _tag: "Copied", from: legacy, to: target });
        assert.deepStrictEqual(yield* snapshot(legacy), before);
        const { "GPUCache/": _cache, "GPUCache/data_0": _shaders, ...copied } = before;
        assert.deepStrictEqual(yield* snapshot(target), copied);
        if (posix) assert.equal((yield* fs.lstat(target)).mode & 0o777, 0o700);
        // Nothing is left beside the two profiles.
        assert.deepStrictEqual((yield* fs.readDirectory(appData)).toSorted(), [legacyName, name]);
        assert.deepStrictEqual(copyLegacyUserData({ appDataDirectory: appData, isDevelopment }), {
          _tag: "AlreadyPresent",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("copies nothing when both profiles exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
      const legacy = yield* makeLegacyProfile(appData, "agentd-desktop");
      const target = path.join(appData, "libraos-next");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(path.join(target, "Preferences"), '{"new":true}');
      const legacyBefore = yield* snapshot(legacy);
      const targetBefore = yield* snapshot(target);

      assert.deepStrictEqual(
        copyLegacyUserData({ appDataDirectory: appData, isDevelopment: false }),
        { _tag: "AlreadyPresent" },
      );
      assert.deepStrictEqual(yield* snapshot(legacy), legacyBefore);
      assert.deepStrictEqual(yield* snapshot(target), targetBefore);
    }).pipe(Effect.scoped),
  );

  it.effect("starts fresh when there is no AgentD Next profile or app data folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
      for (const appDataDirectory of [appData, path.join(appData, "missing")]) {
        assert.deepStrictEqual(copyLegacyUserData({ appDataDirectory, isDevelopment: false }), {
          _tag: "NoLegacyProfile",
        });
      }
      assert.deepStrictEqual(yield* fs.readDirectory(appData), []);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!posix)("follows no link out of the profile and skips the profile lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-outside-" });
      yield* fs.writeFileString(path.join(outside, "id_ed25519"), "private key");
      const legacy = yield* makeLegacyProfile(appData, "agentd-desktop");
      yield* fs.symlink(outside, path.join(legacy, "linked-folder"));
      yield* fs.symlink(path.join(outside, "id_ed25519"), path.join(legacy, "linked-file"));
      yield* fs.symlink("host-1234", path.join(legacy, "SingletonLock"));

      copyLegacyUserData({ appDataDirectory: appData, isDevelopment: false });

      const copied = yield* snapshot(path.join(appData, "libraos-next"));
      assert.deepStrictEqual(Object.keys(copied).toSorted(), [
        "Local Storage/",
        "Local Storage/leveldb/",
        "Local Storage/leveldb/000003.log",
        "Preferences",
      ]);
      assert.equal(copied["Local Storage/leveldb/000003.log"], "tokens (600)");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!posix)("does not copy a profile folder that is a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-elsewhere-" });
      yield* makeLegacyProfile(elsewhere, "profile");
      yield* fs.symlink(path.join(elsewhere, "profile"), path.join(appData, "agentd-desktop"));

      assert.deepInclude(copyLegacyUserData({ appDataDirectory: appData, isDevelopment: false }), {
        _tag: "LegacyProfileNotADirectory",
      });
      assert.isFalse(yield* fs.exists(path.join(appData, "libraos-next")));
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a copy an earlier start left unfinished", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appData = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-user-data-" });
      yield* makeLegacyProfile(appData, "agentd-desktop");
      const unfinished = path.join(appData, "libraos-next.partial-1");
      yield* fs.makeDirectory(unfinished);
      yield* fs.writeFileString(path.join(unfinished, "Preferences"), "half");

      assert.equal(
        copyLegacyUserData({ appDataDirectory: appData, isDevelopment: false })._tag,
        "Copied",
      );
      assert.deepStrictEqual((yield* fs.readDirectory(appData)).toSorted(), [
        "agentd-desktop",
        "libraos-next",
      ]);
      assert.equal(
        yield* fs.readFileString(path.join(appData, "libraos-next", "Preferences")),
        "{}",
      );
    }).pipe(Effect.scoped),
  );
});
