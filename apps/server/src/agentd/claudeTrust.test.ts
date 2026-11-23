// @effect-diagnostics-next-line nodeBuiltinImport:off -- Windows path rules on any host.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeConfigFile,
  isTrusted,
  makeClaudeTrust,
  projectFolder,
  trustKey,
  withTrust,
} from "./claudeTrust.ts";

const { posix, win32 } = NodePath;

// The shape of a real ~/.claude.json, with made-up values for the keys that must stay untouched.
const FIXTURE = `{
  "numStartups": 12,
  "oauthAccount": {
    "accountUuid": "00000000-0000-4000-8000-000000000000",
    "emailAddress": "someone@example.com"
  },
  "primaryApiKey": "sk-ant-not-a-real-key",
  "projects": {
    "/home/dev/trusted": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true
    },
    "/home/dev/app": {
      "allowedTools": ["Bash(ls)"],
      "mcpServers": {},
      "hasTrustDialogAccepted": false
    }
  }
}
`;

describe("claudeConfigFile", () => {
  it.each([
    [{}, "/home/dev", posix, "/home/dev/.claude.json"],
    [{ CLAUDE_CONFIG_DIR: "/etc/claude" }, "/home/dev", posix, "/etc/claude/.claude.json"],
    [{ CLAUDE_CONFIG_DIR: "  " }, "/home/dev", posix, "/home/dev/.claude.json"],
    [{}, "C:\\Users\\dev", win32, "C:\\Users\\dev\\.claude.json"],
    [{ CLAUDE_CONFIG_DIR: "D:\\claude" }, "C:\\Users\\dev", win32, "D:\\claude\\.claude.json"],
  ] as const)("%j in %s", (env, home, path, file) => {
    expect(claudeConfigFile(env, home, path)).toBe(file);
  });
});

describe("trust keys and lookup", () => {
  it("keys Windows folders with forward slashes, as Claude Code does", () => {
    expect(trustKey("C:\\Users\\dev\\app\\", win32)).toBe("C:/Users/dev/app");
    expect(trustKey("/home/dev/app/", posix)).toBe("/home/dev/app");
  });

  it("finds trust on the folder or a parent only", () => {
    const config = JSON.parse(FIXTURE);
    expect(isTrusted(config, "/home/dev/trusted", posix)).toBe(true);
    expect(isTrusted(config, "/home/dev/trusted/packages/web", posix)).toBe(true);
    expect(isTrusted(config, "/home/dev/app", posix)).toBe(false);
    expect(isTrusted(config, "/home/dev", posix)).toBe(false);
    expect(
      isTrusted(
        { projects: { "C:/work": { hasTrustDialogAccepted: true } } },
        "C:\\work\\repo",
        win32,
      ),
    ).toBe(true);
    expect(isTrusted(null, "/home/dev/app", posix)).toBe(false);
  });

  it("keys a worktree by its main checkout", () => {
    expect(projectFolder("/home/dev/app", "/home/dev/app/.git\n", posix)).toBe("/home/dev/app");
    expect(projectFolder("/home/dev/app/web", "/home/dev/app/.git", posix)).toBe("/home/dev/app");
    expect(projectFolder("/home/dev/wt/fix", "/home/dev/app/.git", posix)).toBe("/home/dev/app");
    expect(projectFolder("C:\\wt\\fix", "C:/src/app/.git", win32)).toBe("C:\\src\\app");
    // Not a Git checkout, or a bare repository: the folder itself.
    expect(projectFolder("/home/dev/notes", null, posix)).toBe("/home/dev/notes");
    expect(projectFolder("/srv/app", "/srv/app.git", posix)).toBe("/srv/app");
  });
});

describe("withTrust", () => {
  it("sets only the folder's trust and keeps every other key", () => {
    const next = JSON.parse(withTrust(FIXTURE, "/home/dev/app", posix)!);
    const before = JSON.parse(FIXTURE);
    expect(next).toEqual({
      ...before,
      projects: {
        ...before.projects,
        "/home/dev/app": { ...before.projects["/home/dev/app"], hasTrustDialogAccepted: true },
      },
    });
    const added = JSON.parse(withTrust(FIXTURE, "/home/dev/new", posix)!);
    expect(added.projects["/home/dev/new"]).toEqual({ hasTrustDialogAccepted: true });
    expect(Object.keys(added)).toEqual(Object.keys(before));
  });

  it("starts a missing or empty config with just that key", () => {
    for (const text of [null, ""]) {
      expect(JSON.parse(withTrust(text, "C:\\src\\app", win32)!)).toEqual({
        projects: { "C:/src/app": { hasTrustDialogAccepted: true } },
      });
    }
  });

  it.each(["{not json", "[]", '{"projects": []}', '{"projects": {"/a": true}}'])(
    "refuses %s rather than overwrite it",
    (text) => {
      expect(withTrust(text, "/a", posix)).toBeNull();
    },
  );
});

describe("makeClaudeTrust", () => {
  it.effect("writes in place of the config, keeping its mode, link and other keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const real = path.join(home, "dotfiles", "claude.json");
      yield* fs.makeDirectory(path.dirname(real));
      yield* fs.writeFileString(real, FIXTURE);
      yield* fs.chmod(real, 0o640);
      yield* fs.symlink(real, path.join(home, ".claude.json"));
      const claude = makeClaudeTrust({ fs, path, env: {}, home });

      expect(yield* claude.trusted("/home/dev/app")).toBe(false);
      yield* claude.trust("/home/dev/app");
      expect(yield* claude.trusted("/home/dev/app")).toBe(true);

      expect((yield* fs.readLink(path.join(home, ".claude.json"))).endsWith("claude.json")).toBe(
        true,
      );
      expect(((yield* fs.stat(real)).mode & 0o777).toString(8)).toBe("640");
      expect(JSON.parse(yield* fs.readFileString(real))).toMatchObject({
        primaryApiKey: "sk-ant-not-a-real-key",
        projects: { "/home/dev/trusted": { hasTrustDialogAccepted: true } },
      });
      // Nothing left beside it.
      expect(yield* fs.readDirectory(path.dirname(real))).toEqual(["claude.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a missing CLAUDE_CONFIG_DIR config, private, and leaves a bad one alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const dir = path.join(home, "claude-config");
      const claude = makeClaudeTrust({ fs, path, env: { CLAUDE_CONFIG_DIR: dir }, home });
      yield* claude.trust("/home/dev/app");
      const file = path.join(dir, ".claude.json");
      expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
        projects: { "/home/dev/app": { hasTrustDialogAccepted: true } },
      });
      expect(yield* fs.exists(path.join(home, ".claude.json"))).toBe(false);
      if ((yield* HostProcess.Platform) !== "win32")
        expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600");

      yield* fs.writeFileString(file, "{broken");
      const refused = yield* Effect.flip(claude.trust("/home/dev/other"));
      expect(refused.message).toContain("isn’t in the expected format");
      expect(refused.message).not.toContain("broken");
      expect(yield* fs.readFileString(file)).toBe("{broken");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
