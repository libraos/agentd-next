import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProcessRunner from "../../processRunner.ts";
import { makeClaudeConnectors, withServerEnabled } from "./claudeConnectors.ts";
import { type ConfigFiles, makeConfigFiles } from "./configFileWrite.ts";

const SECRET = "sk-very-secret-value";

const output = (code: number, stderr = "") => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const dir = yield* fs.makeTempDirectoryScoped();
  const configDir = path.join(dir, "claude-home");
  const cwd = path.join(dir, "repo");
  const managedDir = path.join(dir, "managed");
  yield* fs.makeDirectory(configDir);
  yield* fs.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
  yield* fs.makeDirectory(managedDir);
  const configFile = path.join(configDir, ".claude.json");
  const project = { cwd, key: cwd.replace(/\\/g, "/") };
  const instance = {
    binaryPath: "claude",
    configDir,
    configFile,
    managedDir,
    environment: { CLAUDE_CONFIG_DIR: configDir },
  };
  const files = makeConfigFiles({ fs, path, platform });
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  // Stands in for `claude mcp add-json` / `remove`, editing the temp config as the CLI does.
  const fakeClaude: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.gen(function* () {
        runs.push(input);
        const config = JSON.parse(yield* fs.readFileString(configFile));
        const [, verb, name, ...rest] = input.args;
        const scope = rest.at(-1);
        const holder = scope === "user" ? config : ((config.projects ??= {})[project.key] ??= {});
        holder.mcpServers ??= {};
        if (verb === "add-json") {
          if (name === undefined || holder.mcpServers[name] !== undefined) {
            return output(1, `MCP server ${name} already exists in ${scope} config`);
          }
          holder.mcpServers[name] = JSON.parse(input.stdin ?? "");
        } else {
          if (name === undefined || holder.mcpServers[name] === undefined) {
            return output(1, `No MCP server named ${name} in ${scope} config`);
          }
          delete holder.mcpServers[name];
        }
        yield* fs.writeFileString(configFile, JSON.stringify(config, null, 2));
        return output(0);
      }).pipe(Effect.orDie),
  };
  const connectors = (overrides: { files?: ConfigFiles; runner?: typeof fakeClaude } = {}) =>
    makeClaudeConnectors({
      fs,
      path,
      files: overrides.files ?? files,
      runner: overrides.runner ?? fakeClaude,
    });
  const writeJson = (file: string, value: unknown) =>
    fs.writeFileString(file, `${JSON.stringify(value, null, 2)}\n`);
  return { fs, path, dir, configFile, project, instance, files, runs, connectors, writeJson };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ClaudeConnectors.list", () => {
  it.effect("lists user, local, project and plugin servers with names only, never values", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, dir, configFile, project, instance, connectors, writeJson } =
          yield* setup;
        yield* writeJson(configFile, {
          mcpServers: {
            docs: {
              type: "http",
              url: "https://docs.example/mcp",
              headers: { Authorization: SECRET },
            },
            tools: { command: "npx", args: ["tools"], env: { TOKEN: SECRET } },
          },
          projects: {
            [project.key]: {
              mcpServers: { mine: { type: "stdio", command: "./mine", env: { KEY: SECRET } } },
              disabledMcpServers: ["tools"],
              enabledMcpjsonServers: ["shared"],
            },
          },
        });
        yield* writeJson(path.join(project.cwd, ".mcp.json"), {
          mcpServers: {
            shared: { type: "sse", url: "https://shared.example/sse" },
            waiting: { command: "wait" },
          },
        });
        const install = path.join(dir, "plugin-install");
        yield* fs.makeDirectory(path.join(install, ".claude-plugin"), { recursive: true });
        yield* writeJson(path.join(install, ".claude-plugin", "plugin.json"), { name: "kit" });
        yield* writeJson(path.join(install, ".mcp.json"), { search: { command: "search" } });
        yield* fs.makeDirectory(path.join(instance.configDir, "plugins"));
        yield* writeJson(path.join(instance.configDir, "plugins", "installed_plugins.json"), {
          version: 2,
          plugins: {
            "kit@market": [{ scope: "user", installPath: install }],
            "off@market": [{ scope: "user", installPath: install }],
          },
        });
        yield* writeJson(path.join(instance.configDir, "settings.json"), {
          enabledPlugins: { "kit@market": true, "off@market": false },
        });

        const listing = yield* connectors().list(instance, project);
        expect(listing.reason).toBeUndefined();
        expect(
          listing.connectors.map((row) => [
            row.scope,
            row.name,
            row.enabled,
            row.toggle,
            row.removable,
          ]),
        ).toEqual([
          ["user", "docs", true, "project", true],
          ["user", "tools", false, "project", true],
          ["local", "mine", true, "project", true],
          ["project", "shared", true, "project", false],
          ["project", "waiting", true, "project", false],
          ["plugin", "plugin:kit:search", true, "project", false],
        ]);
        const docs = listing.connectors[0];
        expect(docs).toMatchObject({
          transport: "http",
          url: "https://docs.example/mcp",
          headerNames: ["Authorization"],
          file: configFile,
        });
        expect(listing.connectors[2]).toMatchObject({ command: "./mine", envNames: ["KEY"] });
        expect(listing.connectors[4]?.problem).toContain("hasn’t been allowed");
        expect(listing.connectors[5]).toMatchObject({
          plugin: "kit",
          file: path.join(install, ".mcp.json"),
        });
        expect(JSON.stringify(listing)).not.toContain(SECRET);
      }),
    ),
  );

  it.effect("without a project lists user servers, all on", () =>
    run(
      Effect.gen(function* () {
        const { configFile, project, instance, connectors, writeJson } = yield* setup;
        yield* writeJson(configFile, {
          mcpServers: { tools: { command: "t" } },
          projects: {
            [project.key]: {
              disabledMcpServers: ["tools"],
              mcpServers: { mine: { command: "m" } },
            },
          },
        });
        const listing = yield* connectors().list(instance, null);
        expect(listing.connectors.map((row) => [row.name, row.enabled])).toEqual([["tools", true]]);
      }),
    ),
  );

  it.effect("marks a user server a local one of the same name replaces", () =>
    run(
      Effect.gen(function* () {
        const { configFile, project, instance, connectors, writeJson } = yield* setup;
        yield* writeJson(configFile, {
          mcpServers: { same: { command: "user" } },
          projects: { [project.key]: { mcpServers: { same: { command: "local" } } } },
        });
        const [user, local] = (yield* connectors().list(instance, project)).connectors;
        expect(user?.problem).toContain("local connector of the same name");
        expect(local?.problem).toBeUndefined();
      }),
    ),
  );

  it.effect("shows managed servers, locked, and the others as unused while they exist", () =>
    run(
      Effect.gen(function* () {
        const { path, configFile, instance, project, connectors, writeJson } = yield* setup;
        yield* writeJson(configFile, { mcpServers: { tools: { command: "t" } } });
        yield* writeJson(path.join(instance.managedDir, "managed-mcp.json"), {
          mcpServers: { corp: { type: "http", url: "https://corp.example/mcp" } },
        });
        const rows = (yield* connectors().list(instance, project)).connectors;
        expect(rows.map((row) => [row.scope, row.name, row.toggle])).toEqual([
          ["user", "tools", "project"],
          ["managed", "corp", "none"],
        ]);
        expect(rows[0]?.problem).toContain("managed-mcp.json");
      }),
    ),
  );

  it.effect("says why when the config isn't JSON, and reads an absent one as empty", () =>
    run(
      Effect.gen(function* () {
        const { fs, configFile, instance, project, connectors } = yield* setup;
        expect(yield* connectors().list(instance, project)).toEqual({ connectors: [] });
        yield* fs.writeFileString(configFile, "{ not json");
        const listing = yield* connectors().list(instance, project);
        expect(listing.reason).toContain("isn’t valid JSON");
      }),
    ),
  );
});

describe("ClaudeConnectors.setEnabled", () => {
  it.effect("switches a server off and on for the project only, keeping the rest", () =>
    run(
      Effect.gen(function* () {
        const { fs, configFile, project, instance, connectors, writeJson } = yield* setup;
        yield* writeJson(configFile, {
          oauthAccount: { emailAddress: "kept" },
          mcpServers: { tools: { command: "t" } },
          projects: {
            [project.key]: { hasTrustDialogAccepted: true },
            "/other": { disabledMcpServers: [] },
          },
        });
        const claude = connectors();
        yield* claude.setEnabled(instance, project, "tools", false);
        let config = JSON.parse(yield* fs.readFileString(configFile));
        expect(config.projects[project.key]).toEqual({
          hasTrustDialogAccepted: true,
          disabledMcpServers: ["tools"],
        });
        expect(config.oauthAccount).toEqual({ emailAddress: "kept" });
        expect(config.projects["/other"]).toEqual({ disabledMcpServers: [] });
        expect((yield* claude.list(instance, project)).connectors[0]?.enabled).toBe(false);
        expect(yield* fs.exists(`${configFile}.bak`)).toBe(true);

        yield* claude.setEnabled(instance, project, "tools", true);
        config = JSON.parse(yield* fs.readFileString(configFile));
        expect(config.projects[project.key].disabledMcpServers).toEqual([]);
        expect((yield* claude.list(instance, project)).connectors[0]?.enabled).toBe(true);
      }),
    ),
  );

  it.effect("fails with changed when Claude keeps saving its config", () =>
    run(
      Effect.gen(function* () {
        const { configFile, project, instance, files, connectors, writeJson } = yield* setup;
        yield* writeJson(configFile, { mcpServers: { tools: { command: "t" } } });
        const busy: ConfigFiles = { ...files, writeIfUnchanged: () => Effect.succeed(false) };
        const error = yield* Effect.flip(
          connectors({ files: busy }).setEnabled(instance, project, "tools", false),
        );
        expect(error.reason).toBe("changed");
      }),
    ),
  );

  it("edits only that project's disabledMcpServers, and refuses a config of another shape", () => {
    const text =
      '{\n  "projects": {\n    "/a": {\n      "disabledMcpServers": ["x"]\n    }\n  }\n}\n';
    expect(JSON.parse(withServerEnabled(text, "/a", "y", false) ?? "")).toEqual({
      projects: { "/a": { disabledMcpServers: ["x", "y"] } },
    });
    expect(withServerEnabled(text, "/a", "y", false)?.endsWith("}\n")).toBe(true);
    expect(withServerEnabled('{"projects": []}', "/a", "y", false)).toBeNull();
    expect(withServerEnabled("[]", "/a", "y", false)).toBeNull();
  });
});

describe("ClaudeConnectors.add and remove", () => {
  it.effect(
    "round-trips a user and a local server through Claude's CLI, values on stdin only",
    () =>
      run(
        Effect.gen(function* () {
          const { configFile, project, instance, runs, connectors, writeJson } = yield* setup;
          yield* writeJson(configFile, {});
          const claude = connectors();
          yield* claude.add(instance, project, "remote", "user", {
            transport: "http",
            url: "https://remote.example/mcp",
            headers: { Authorization: SECRET },
          });
          yield* claude.add(instance, project, "tool", "local", {
            transport: "stdio",
            command: "tool",
            args: ["--fast"],
            env: { TOKEN: SECRET },
          });
          expect(runs.map((input) => [input.args, input.cwd])).toEqual([
            [["mcp", "add-json", "remote", "-", "--scope", "user"], undefined],
            [["mcp", "add-json", "tool", "-", "--scope", "local"], project.cwd],
          ]);
          expect(runs.every((input) => !input.args.join(" ").includes(SECRET))).toBe(true);
          expect(runs[0]?.env).toEqual(instance.environment);
          expect(JSON.parse(runs[1]?.stdin ?? "")).toEqual({
            type: "stdio",
            command: "tool",
            args: ["--fast"],
            env: { TOKEN: SECRET },
          });
          const added = (yield* claude.list(instance, project)).connectors;
          expect(added.map((row) => [row.scope, row.name])).toEqual([
            ["user", "remote"],
            ["local", "tool"],
          ]);

          yield* claude.remove(instance, project, "remote", "user");
          yield* claude.remove(instance, project, "tool", "local");
          expect(runs.slice(2).map((input) => input.args)).toEqual([
            ["mcp", "remove", "remote", "--scope", "user"],
            ["mcp", "remove", "tool", "--scope", "local"],
          ]);
          expect((yield* claude.list(instance, project)).connectors).toEqual([]);
        }),
      ),
  );

  it.effect("passes on what Claude says when it refuses, without the values", () =>
    run(
      Effect.gen(function* () {
        const { project, instance, connectors } = yield* setup;
        const echoing: ProcessRunner.ProcessRunner["Service"] = {
          run: (input) => Effect.succeed(output(1, `Invalid configuration: ${input.stdin}`)),
        };
        const error = yield* Effect.flip(
          connectors({ runner: echoing }).add(instance, project, "x", "user", {
            transport: "stdio",
            command: "x",
            args: [],
            env: { TOKEN: SECRET },
          }),
        );
        expect(error.reason).toBe("failed");
        expect(error.message).toContain("Invalid configuration");
        expect(error.message).not.toContain(SECRET);
      }),
    ),
  );
});
