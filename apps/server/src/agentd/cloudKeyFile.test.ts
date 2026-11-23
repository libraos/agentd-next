// @effect-diagnostics-next-line nodeBuiltinImport:off -- mkfifo once, for a named pipe fixture.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { keyFileProvider, makeCloudKeyFile } from "./cloudKeyFile.ts";

describe("keyFileProvider", () => {
  it.each([
    ["sk-ant-api0", "anthropic"],
    ["﻿sk-ant-ap", "anthropic"],
    ["sk-proj-ab", "openai"],
    ["sk-abcdefg", "openai"],
    // agentd trims leading whitespace before it reads the key.
    [" sk-ant-api03", "anthropic"],
    ["\n\t sk-proj-ab", "openai"],
    // A prefix cut off inside "sk-ant-" could be either provider's.
    [`${" ".repeat(44)}sk-a`, null],
    ["sk-", null],
    ["lcw_live_0", null],
    ["", null],
  ] as const)("%s", (prefix, provider) => {
    expect(keyFileProvider(prefix)).toBe(provider);
  });
});

describe("makeCloudKeyFile", () => {
  it.effect("tells the provider by the first bytes, and makes a shared file private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const check = makeCloudKeyFile({
        isAbsolute: path.isAbsolute,
        platform: "linux",
        uid: process.getuid?.(),
      });
      const anthropic = path.join(dir, "openai.key");
      yield* fs.writeFileString(anthropic, "sk-ant-api03-secret\n");
      yield* fs.chmod(anthropic, 0o644);
      expect(yield* check({ path: anthropic }, false)).toEqual({
        provider: "anthropic",
        readable: true,
        openToOthers: true,
      });
      expect(yield* check({ path: anthropic }, true)).toEqual({
        provider: "anthropic",
        readable: true,
        openToOthers: false,
      });
      expect(((yield* fs.stat(anthropic)).mode & 0o777).toString(8)).toBe("600");
      // Leading whitespace agentd trims doesn't cut the key short.
      const padded = path.join(dir, "padded.key");
      yield* fs.writeFileString(padded, `${" ".repeat(44)}sk-ant-api03-secret\n`);
      expect(yield* check({ path: padded }, false)).toMatchObject({ provider: "anthropic" });
      expect(yield* check({ path: path.join(dir, "missing.key") }, false)).toEqual({
        provider: null,
        readable: false,
        openToOthers: false,
      });
      expect(yield* check({ path: dir }, false)).toMatchObject({ readable: false });
      // A repair that couldn't run fails instead of answering "unreadable".
      const gone = yield* Effect.flip(check({ path: path.join(dir, "missing.key") }, true));
      expect(gone.message).toContain("couldn’t be opened");
      // Windows has no mode for agentd to refuse, so nothing is reported or changed.
      const windows = makeCloudKeyFile({
        isAbsolute: path.isAbsolute,
        platform: "win32",
        uid: undefined,
      });
      yield* fs.chmod(anthropic, 0o644);
      expect(yield* windows({ path: anthropic }, true)).toMatchObject({ openToOthers: false });
      expect(((yield* fs.stat(anthropic)).mode & 0o777).toString(8)).toBe("644");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "changes nothing that is not the user's own regular file, and never waits on a pipe",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const uid = process.getuid?.();
        const check = makeCloudKeyFile({ isAbsolute: path.isAbsolute, platform: "linux", uid });
        const project = path.join(dir, "project");
        yield* fs.makeDirectory(project);
        yield* fs.chmod(project, 0o755);
        const fixDir = yield* Effect.flip(check({ path: project }, true));
        expect(fixDir.message).toContain("not a regular file");
        expect(((yield* fs.stat(project)).mode & 0o777).toString(8)).toBe("755");

        if ((yield* HostProcess.Platform) !== "win32") {
          const pipe = path.join(dir, "key.fifo");
          NodeChildProcess.execFileSync("mkfifo", [pipe]);
          expect(yield* check({ path: pipe }, false)).toMatchObject({ readable: false });
          yield* Effect.flip(check({ path: pipe }, true));
        }

        // Only a file that looks like a credential: not a program, a document or a large file.
        const notKeys = [
          ["tool.sh", "#!/bin/sh\necho hi\n", 0o755],
          ["notes.txt", "meeting notes\n", 0o644],
          ["key-but-executable", "sk-ant-api03-secret\n", 0o755],
          ["huge.json", `{${" ".repeat(70 * 1024)}}`, 0o644],
          ["settings.json", '{"theme":"dark","editor":{"tabSize":2}}\n', 0o644],
          ["broken.json", '{"tokens": ', 0o644],
        ] as const;
        for (const [name, text, mode] of notKeys) {
          const file = path.join(dir, name);
          yield* fs.writeFileString(file, text);
          yield* fs.chmod(file, mode);
          const refused = yield* Effect.flip(check({ path: file }, true));
          expect(refused.message, name).toContain("doesn’t look like a key or token file");
          expect(((yield* fs.stat(file)).mode & 0o777).toString(8), name).toBe(mode.toString(8));
        }
        // Codex's auth.json is JSON and is made private.
        const auth = path.join(dir, "auth.json");
        yield* fs.writeFileString(auth, '\uFEFF{"auth_mode":"chatgpt","tokens":{}}\n');
        yield* fs.chmod(auth, 0o644);
        yield* check({ path: auth }, true);
        expect(((yield* fs.stat(auth)).mode & 0o777).toString(8)).toBe("600");

        const theirs = path.join(dir, "theirs.key");
        yield* fs.writeFileString(theirs, "sk-ant-api03-secret\n");
        yield* fs.chmod(theirs, 0o644);
        const other = makeCloudKeyFile({
          isAbsolute: path.isAbsolute,
          platform: "linux",
          uid: (uid ?? 0) + 1,
        });
        const fixTheirs = yield* Effect.flip(other({ path: theirs }, true));
        expect(fixTheirs.message).toContain("another user");
        expect(((yield* fs.stat(theirs)).mode & 0o777).toString(8)).toBe("644");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
