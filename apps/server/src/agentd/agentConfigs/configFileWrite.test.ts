// The publish races of Orca's agent-config-publish-race.test.ts (https://github.com/stablyai/orca,
// MIT License, commit bf0997cfed9e0ac10e73ee98c5179c87d4329743), driven through a FileSystem whose
// calls let another writer save at each step of a publish.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { makeConfigFiles } from "./configFileWrite.ts";

const BEFORE = '{\n  "projects": {}\n}\n';
const EDIT = '{\n  "projects": {\n    "/a": {}\n  }\n}\n';
const SAVED = '{\n  "saved": "by the agent"\n}\n';

type Step = "copyFile" | "hold" | "publish";

/** A FileSystem that runs `save` once, just before the publish reaches `step`. */
const racing = (
  fs: FileSystem.FileSystem,
  step: Step,
  save: Effect.Effect<void, PlatformError.PlatformError>,
) => {
  let fired = false;
  const once = Effect.suspend(() => {
    if (fired) return Effect.void;
    fired = true;
    return save.pipe(Effect.orDie);
  });
  return {
    ...fs,
    copyFile: (from, to) =>
      (step === "copyFile" ? once : Effect.void).pipe(Effect.andThen(fs.copyFile(from, to))),
    rename: (from, to) =>
      (step === "hold" && to.endsWith(".agentd-publishing") ? once : Effect.void).pipe(
        Effect.andThen(fs.rename(from, to)),
      ),
    link: (from, to) =>
      (step === "publish" && from.endsWith(".tmp") && !to.endsWith(".tmp")
        ? once
        : Effect.void
      ).pipe(Effect.andThen(fs.link(from, to))),
  } satisfies FileSystem.FileSystem;
};

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const dir = yield* fs.makeTempDirectoryScoped();
  const file = path.join(dir, ".claude.json");
  yield* fs.writeFileString(file, BEFORE);
  yield* fs.chmod(file, 0o640);
  let id = 0;
  const files = (over: FileSystem.FileSystem = fs) =>
    makeConfigFiles({ fs: over, path, platform, newId: () => `id${++id}` });
  const mode = (name: string) => fs.stat(name).pipe(Effect.map((info) => info.mode & 0o777));
  const listing = fs.readDirectory(dir).pipe(Effect.map((names) => names.toSorted()));
  return { fs, path, platform, dir, file, files, mode, listing };
});

describe("writeIfUnchanged", () => {
  it.effect(
    "publishes the edit, keeping the mode, with the old text in a .bak of the same mode",
    () =>
      Effect.gen(function* () {
        const { fs, file, files, mode, listing, platform } = yield* setup;
        expect(yield* files().writeIfUnchanged(file, EDIT, BEFORE)).toBe(true);
        expect(yield* fs.readFileString(file)).toBe(EDIT);
        expect(yield* fs.readFileString(`${file}.bak`)).toBe(BEFORE);
        if (platform !== "win32") {
          expect((yield* mode(file)).toString(8)).toBe("640");
          expect((yield* mode(`${file}.bak`)).toString(8)).toBe("640");
        }
        expect(yield* listing).toEqual([".claude.json", ".claude.json.bak"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an edit made from text the file no longer holds", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      yield* fs.writeFileString(file, SAVED);
      expect(yield* files().writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* listing).toEqual([".claude.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save while the backup is copied keeps the save and the previous backup", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      yield* fs.writeFileString(`${file}.bak`, "previous backup");
      const over = racing(fs, "copyFile", fs.writeFileString(file, SAVED));
      expect(yield* files(over).writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* fs.readFileString(`${file}.bak`)).toBe("previous backup");
      expect(yield* listing).toEqual([".claude.json", ".claude.json.bak"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save that replaces the file just before it is held aside is kept", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      // Agents save by writing a new file and renaming it over the config.
      const replace = fs
        .writeFileString(`${file}.agent-tmp`, SAVED)
        .pipe(Effect.andThen(fs.rename(`${file}.agent-tmp`, file)));
      expect(yield* files(racing(fs, "hold", replace)).writeIfUnchanged(file, EDIT, BEFORE)).toBe(
        false,
      );
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* listing).toEqual([".claude.json", ".claude.json.bak"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save while the file is held aside wins; the held text is kept beside it", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      const over = racing(fs, "publish", fs.writeFileString(file, SAVED));
      expect(yield* files(over).writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      const names = yield* listing;
      const kept = names.find((name) => name.includes(".agentd-kept-"));
      expect(kept).toBeDefined();
      expect(yield* fs.readFileString(`${file.slice(0, -".claude.json".length)}${kept}`)).toBe(
        BEFORE,
      );
      expect(names.some((name) => name.endsWith(".agentd-publishing"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("two edits from the same text: exactly one is published", () =>
    Effect.gen(function* () {
      const { fs, file, files } = yield* setup;
      const config = files();
      const results = yield* Effect.all(
        [config.writeIfUnchanged(file, EDIT, BEFORE), config.writeIfUnchanged(file, SAVED, BEFORE)],
        { concurrency: "unbounded" },
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(yield* fs.readFileString(file)).toBe(results[0] ? EDIT : SAVED);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes through a dotfile symlink, which stays a link", () =>
    Effect.gen(function* () {
      const { fs, path, dir, file, files } = yield* setup;
      const link = path.join(dir, "linked.json");
      yield* fs.symlink(file, link);
      expect(yield* files().writeIfUnchanged(link, EDIT, BEFORE)).toBe(true);
      expect((yield* fs.lstat(link)).type).toBe("SymbolicLink");
      expect(yield* fs.readFileString(file)).toBe(EDIT);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to replace a symlinked backup", () =>
    Effect.gen(function* () {
      const { fs, path, dir, file, files } = yield* setup;
      const elsewhere = path.join(dir, "elsewhere");
      yield* fs.writeFileString(elsewhere, "not a backup");
      yield* fs.symlink(elsewhere, `${file}.bak`);
      const error = yield* Effect.flip(files().writeIfUnchanged(file, EDIT, BEFORE));
      expect(error.message).toContain("symlinked backup");
      expect(yield* fs.readFileString(file)).toBe(BEFORE);
      expect(yield* fs.readFileString(elsewhere)).toBe("not a backup");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates an absent config private, unless one appeared meanwhile", () =>
    Effect.gen(function* () {
      const { fs, path, dir, files, mode, platform } = yield* setup;
      const fresh = path.join(dir, "new-home", ".claude.json");
      expect(yield* files().writeIfUnchanged(fresh, EDIT, null)).toBe(true);
      expect(yield* fs.readFileString(fresh)).toBe(EDIT);
      if (platform !== "win32") expect((yield* mode(fresh)).toString(8)).toBe("600");
      expect(yield* files().writeIfUnchanged(fresh, SAVED, null)).toBe(false);
      expect(yield* fs.readFileString(fresh)).toBe(EDIT);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("read", () => {
  it.effect("puts back a config a stopped publish left held aside", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      yield* fs.rename(file, `${file}.agentd-publishing`);
      expect(yield* files().read(file)).toBe(BEFORE);
      expect(yield* listing).toEqual([".claude.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is null for an absent file", () =>
    Effect.gen(function* () {
      const { path, dir, files } = yield* setup;
      expect(yield* files().read(path.join(dir, "missing.json"))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
