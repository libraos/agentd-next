// The "Orca's publish races" block is ported from Orca (https://github.com/stablyai/orca, MIT
// License), file src/main/mcp-servers/agent-configs/agent-config-publish-race.test.ts at commit
// bf0997cfed9e0ac10e73ee98c5179c87d4329743, onto Effect's FileSystem and the writer here.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { type ConfigFiles, makeConfigFiles } from "./configFileWrite.ts";

const BEFORE = '{\n  "projects": {}\n}\n';
const EDIT = '{\n  "projects": {\n    "/a": {}\n  }\n}\n';
const SAVED = '{\n  "saved": "by the agent"\n}\n';

interface Race {
  /** `save` runs once, just before anything is published (renamed, linked, copied) where `at` says. */
  readonly at: (destination: string) => boolean;
  readonly save: Effect.Effect<void, PlatformError.PlatformError>;
  readonly noLinks?: boolean;
}

const racing = (fs: FileSystem.FileSystem, race: Race) => {
  let pending = true;
  const beforePublishTo = (destination: string) =>
    Effect.suspend(() => {
      if (!pending || !race.at(destination)) return Effect.void;
      pending = false;
      return race.save.pipe(Effect.orDie);
    });
  const over = {
    ...fs,
    rename: (from, to) => beforePublishTo(to).pipe(Effect.andThen(fs.rename(from, to))),
    link: (from, to) =>
      race.noLinks
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "link",
              description: "operation not supported",
              pathOrDescriptor: to,
            }),
          )
        : beforePublishTo(to).pipe(Effect.andThen(fs.link(from, to))),
    copyFile: (from, to) => beforePublishTo(to).pipe(Effect.andThen(fs.copyFile(from, to))),
  } satisfies FileSystem.FileSystem;
  return { fs: over, fired: () => !pending };
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
  const listing = (folder = dir) =>
    fs.readDirectory(folder).pipe(Effect.map((names) => names.toSorted()));
  return { fs, path, platform, dir, file, files, mode, listing };
});

describe("Orca's publish races", () => {
  const server = '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n';

  const codexGithub = Effect.gen(function* () {
    const context = yield* setup;
    const { fs, path, dir } = context;
    const codexHome = path.join(dir, ".codex");
    const config = path.join(codexHome, "config.toml");
    yield* fs.makeDirectory(codexHome);
    yield* fs.writeFileString(config, `model = "before"\n\n${server}`);
    return { ...context, codexHome, config };
  });

  // Orca's removal redoes its edit on a newer save, as the callers of the writer here do.
  const removeGithub = (files: ConfigFiles, config: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = yield* files.read(config);
        if (text === null) return;
        if (yield* files.writeIfUnchanged(config, text.replace(`\n${server}`, ""), text)) return;
      }
      return yield* Effect.die("The config kept changing.");
    });

  it.effect("keeps a Codex config save that lands just before the new file replaces it", () =>
    Effect.gen(function* () {
      const { fs, config, files } = yield* codexGithub;
      // Codex saves its config after the last check of the bytes, before the new file goes in.
      const race = racing(fs, {
        at: (to) => to === config,
        save: fs.writeFileString(config, `model = "user-just-saved"\n\n${server}`),
      });
      yield* removeGithub(files(race.fs), config);

      expect(race.fired()).toBe(true);
      expect(yield* fs.readFileString(config)).toBe('model = "user-just-saved"\n');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a config alone on a drive without hard links", () =>
    Effect.gen(function* () {
      const { fs, codexHome, config, files, listing } = yield* codexGithub;
      const race = racing(fs, { at: () => false, save: Effect.void, noLinks: true });

      const error = yield* Effect.flip(removeGithub(files(race.fs), config));
      expect(error.message).toContain("can't be edited");
      expect(yield* fs.readFileString(config)).toBe(`model = "before"\n\n${server}`);
      expect(yield* listing(codexHome)).toEqual(["config.toml", "config.toml.bak"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("puts back a config the app held aside when it quit mid-publish", () =>
    Effect.gen(function* () {
      const { fs, path, dir, files, listing } = yield* setup;
      const home = path.join(dir, "home");
      yield* fs.makeDirectory(home);
      const config = path.join(home, "mcp.json");
      const mine = '{ "mcpServers": { "mine": { "command": "m" } } }';
      yield* fs.writeFileString(`${config}.agentd-publishing`, mine);

      expect(yield* files().read(config)).toBe(mine);
      expect(yield* listing(home)).toEqual(["mcp.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "edits the file a relative dotfile link names, read from its linked folder",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir, files } = yield* setup;
        // ~/.codex -> dotfiles/codex, and config.toml -> ../common/config.toml inside dotfiles.
        yield* fs.makeDirectory(path.join(dir, "dotfiles", "codex"), { recursive: true });
        yield* fs.makeDirectory(path.join(dir, "dotfiles", "common"));
        yield* fs.makeDirectory(path.join(dir, "common"));
        const real = path.join(dir, "dotfiles", "common", "config.toml");
        const decoy = path.join(dir, "common", "config.toml");
        yield* fs.writeFileString(real, "a = 1\n");
        yield* fs.writeFileString(decoy, "a = 1\n");
        yield* fs.symlink(path.join(dir, "dotfiles", "codex"), path.join(dir, ".codex"));
        yield* fs.symlink(
          "../common/config.toml",
          path.join(dir, "dotfiles", "codex", "config.toml"),
        );

        const config = path.join(dir, ".codex", "config.toml");
        expect(yield* files().writeIfUnchanged(config, "a = 2\n", "a = 1\n")).toBe(true);
        expect([yield* fs.readFileString(real), yield* fs.readFileString(decoy)]).toEqual([
          "a = 2\n",
          "a = 1\n",
        ]);
        expect((yield* fs.lstat(path.join(dir, "dotfiles", "codex", "config.toml"))).type).toBe(
          "SymbolicLink",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
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
        expect(yield* listing()).toEqual([".claude.json", ".claude.json.bak"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an edit made from text the file no longer holds", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      yield* fs.writeFileString(file, SAVED);
      expect(yield* files().writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* listing()).toEqual([".claude.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save while the backup is copied keeps the save and the previous backup", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      yield* fs.writeFileString(`${file}.bak`, "previous backup");
      const race = racing(fs, {
        at: (to) => to.startsWith(`${file}.bak.`),
        save: fs.writeFileString(file, SAVED),
      });
      expect(yield* files(race.fs).writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(race.fired()).toBe(true);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* fs.readFileString(`${file}.bak`)).toBe("previous backup");
      expect(yield* listing()).toEqual([".claude.json", ".claude.json.bak"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save that replaces the file just before it is held aside is kept", () =>
    Effect.gen(function* () {
      const { fs, file, files, listing } = yield* setup;
      // Agents save by writing a new file and renaming it over the config.
      const race = racing(fs, {
        at: (to) => to === `${file}.agentd-publishing`,
        save: fs
          .writeFileString(`${file}.agent-tmp`, SAVED)
          .pipe(Effect.andThen(fs.rename(`${file}.agent-tmp`, file))),
      });
      expect(yield* files(race.fs).writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(race.fired()).toBe(true);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      expect(yield* listing()).toEqual([".claude.json", ".claude.json.bak"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a save while the file is held aside wins; the held text is kept beside it", () =>
    Effect.gen(function* () {
      const { fs, path, dir, file, files, listing } = yield* setup;
      const race = racing(fs, { at: (to) => to === file, save: fs.writeFileString(file, SAVED) });
      expect(yield* files(race.fs).writeIfUnchanged(file, EDIT, BEFORE)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe(SAVED);
      const names = yield* listing();
      const kept = names.find((name) => name.includes(".agentd-kept-"));
      expect(kept).toBeDefined();
      expect(yield* fs.readFileString(path.join(dir, kept ?? ""))).toBe(BEFORE);
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
  it.effect("is null for an absent file", () =>
    Effect.gen(function* () {
      const { path, dir, files } = yield* setup;
      expect(yield* files().read(path.join(dir, "missing.json"))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
