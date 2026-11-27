import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { type CodexConfigApi, makeCodexConnectors } from "./codexConnectors.ts";

const SECRET = "sk-very-secret-value";
const USER_FILE = "/home/me/.codex/config.toml";
const PROJECT_DOT_CODEX = "/repo/.codex";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Codex's app-server over in-memory layers: merged config, leaf origins, versioned writes. */
const fakeCodex = (layers: {
  user: Json;
  project?: Json;
  projectDisabled?: string;
  system?: Json;
}) => {
  let user = structuredClone(layers.user);
  let version = 1;
  const writes: Array<CodexSchema.V2ConfigBatchWriteParams> = [];
  const sources = {
    system: { type: "system" as const, file: "/etc/codex/config.toml" },
    user: { type: "user" as const, file: USER_FILE, profile: null },
    project: { type: "project" as const, dotCodexFolder: PROJECT_DOT_CODEX },
  };
  const userVersion = () => `sha256:user-${version}`;
  const merge = (
    into: Json,
    from: Json,
    source: CodexSchema.V2ConfigReadResponse__ConfigLayerSource,
    at: string,
    origins: Json,
  ) => {
    for (const [key, value] of Object.entries(from)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (isObject(value)) {
        const child = isObject(into[key]) ? into[key] : {};
        into[key] = child;
        merge(child, value, source, path, origins);
      } else {
        into[key] = value;
        origins[path] = { name: source, version: source.type === "user" ? userVersion() : "v" };
      }
    }
  };
  const api: CodexConfigApi = {
    read: () =>
      Effect.sync(() => {
        const config: Json = {};
        const origins: Json = {};
        merge(config, layers.system ?? {}, sources.system, "", origins);
        merge(config, user, sources.user, "", origins);
        if (layers.project && !layers.projectDisabled)
          merge(config, layers.project, sources.project, "", origins);
        // Codex fills defaults it reads no origin for.
        for (const server of Object.values(isObject(config.mcp_servers) ? config.mcp_servers : {}))
          if (isObject(server)) server.enabled ??= true;
        return {
          config,
          origins,
          layers: [
            ...(layers.project
              ? [
                  {
                    name: sources.project,
                    version: "v",
                    config: layers.project,
                    ...(layers.projectDisabled ? { disabledReason: layers.projectDisabled } : {}),
                  },
                ]
              : []),
            { name: sources.user, version: userVersion(), config: user },
            { name: sources.system, version: "v", config: layers.system ?? {} },
          ],
        } as unknown as CodexSchema.V2ConfigReadResponse;
      }),
    write: (params) =>
      Effect.gen(function* () {
        writes.push(params);
        if (params.expectedVersion !== undefined && params.expectedVersion !== userVersion()) {
          return yield* new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage:
              "Configuration was modified since last read. Fetch latest version and retry.",
            data: { config_write_error_code: "configVersionConflict" },
          });
        }
        const next = structuredClone(user);
        for (const edit of params.edits) {
          const keys = edit.keyPath.split(".");
          const last = keys.pop() ?? "";
          let table = next;
          for (const key of keys) table = (table[key] ??= {}) as Json;
          if (edit.value === null) delete table[last];
          else table[last] = structuredClone(edit.value);
        }
        user = next;
        version++;
        return { status: "ok", version: userVersion(), filePath: USER_FILE };
      }),
  };
  return { api, writes, user: () => user, bump: () => version++ };
};

const codex = makeCodexConnectors({ join: (...parts) => parts.join("/") });

describe("CodexConnectors.list", () => {
  it.effect("lists each server with the scope its origin gives, names only, never values", () =>
    Effect.gen(function* () {
      const { api } = fakeCodex({
        system: { mcp_servers: { corp: { url: "https://corp.example/mcp" } } },
        user: {
          mcp_servers: {
            docs: {
              url: "https://docs.example/mcp",
              http_headers: { Authorization: SECRET },
              env_http_headers: { "X-Team": "TEAM_TOKEN" },
              bearer_token_env_var: "DOCS_TOKEN",
            },
            tools: { command: "npx", args: ["tools"], env: { TOKEN: SECRET }, enabled: false },
            "dot.name": { command: "x" },
          },
        },
        project: { mcp_servers: { repo: { command: "./repo-mcp", env_vars: ["REPO_KEY"] } } },
      });
      const listing = yield* codex.list(api, "/repo");
      expect(
        listing.connectors.map((row) => [
          row.scope,
          row.name,
          row.enabled,
          row.toggle,
          row.removable,
        ]),
      ).toEqual([
        ["managed", "corp", true, "none", false],
        ["user", "docs", true, "user", true],
        ["user", "dot.name", true, "none", false],
        ["project", "repo", true, "none", false],
        ["user", "tools", false, "user", true],
      ]);
      expect(listing.connectors[1]).toMatchObject({
        transport: "http",
        url: "https://docs.example/mcp",
        headerNames: ["Authorization", "X-Team"],
        envNames: ["DOCS_TOKEN", "TEAM_TOKEN"],
        file: USER_FILE,
      });
      expect(listing.connectors[2]?.problem).toContain("dot");
      expect(listing.connectors[3]).toMatchObject({
        command: "./repo-mcp",
        envNames: ["REPO_KEY"],
        file: `${PROJECT_DOT_CODEX}/config.toml`,
      });
      expect(listing.connectors[4]).toMatchObject({ envNames: ["TOKEN"], args: ["tools"] });
      expect(listing.userVersion).toBe("sha256:user-1");
      expect(JSON.stringify(listing)).not.toContain(SECRET);
    }),
  );

  it.effect("shows a project's servers Codex ignores, with its reason", () =>
    Effect.gen(function* () {
      const { api } = fakeCodex({
        user: {},
        project: { mcp_servers: { repo: { command: "./repo-mcp" } } },
        projectDisabled: "This project isn't trusted.",
      });
      const [repo] = (yield* codex.list(api, "/repo")).connectors;
      expect(repo).toMatchObject({
        scope: "project",
        enabled: false,
        toggle: "none",
        problem: "This project isn't trusted.",
      });
    }),
  );

  it.effect("locks the switch of a user server another layer switches", () =>
    Effect.gen(function* () {
      const { api } = fakeCodex({
        user: { mcp_servers: { tools: { command: "t" } } },
        project: { mcp_servers: { tools: { enabled: false } } },
      });
      const [tools] = (yield* codex.list(api, "/repo")).connectors;
      expect(tools).toMatchObject({ scope: "user", enabled: false, toggle: "none" });
      expect(tools?.problem).toContain("another of Codex’s config files");
    }),
  );
});

describe("CodexConnectors writes", () => {
  it.effect(
    "switches mcp_servers.<name>.enabled against the version read, and the list follows",
    () =>
      Effect.gen(function* () {
        const { api, writes } = fakeCodex({ user: { mcp_servers: { tools: { command: "t" } } } });
        const before = yield* codex.list(api, null);
        yield* codex.setEnabled(api, "tools", false, before.userVersion);
        expect(writes[0]).toEqual({
          edits: [{ keyPath: "mcp_servers.tools.enabled", value: false, mergeStrategy: "replace" }],
          expectedVersion: "sha256:user-1",
          reloadUserConfig: true,
        });
        expect((yield* codex.list(api, null)).connectors[0]?.enabled).toBe(false);
      }),
  );

  it.effect("fails with changed when Codex saved its config after the read", () =>
    Effect.gen(function* () {
      const { api, bump } = fakeCodex({ user: { mcp_servers: { tools: { command: "t" } } } });
      const before = yield* codex.list(api, null);
      bump();
      const error = yield* Effect.flip(codex.setEnabled(api, "tools", false, before.userVersion));
      expect(error.reason).toBe("changed");
    }),
  );

  it.effect("adds a whole server table and removes it again", () =>
    Effect.gen(function* () {
      const fake = fakeCodex({ user: { model: "kept" } });
      const { api } = fake;
      yield* codex.add(
        api,
        "tool",
        {
          transport: "stdio",
          command: "npx",
          args: ["-y", "tool"],
          env: { TOKEN: SECRET },
        },
        (yield* codex.list(api, null)).userVersion,
      );
      yield* codex.add(
        api,
        "remote",
        {
          transport: "http",
          url: "https://remote.example/mcp",
          headers: {},
        },
        (yield* codex.list(api, null)).userVersion,
      );
      expect(fake.user()).toEqual({
        model: "kept",
        mcp_servers: {
          tool: { command: "npx", args: ["-y", "tool"], env: { TOKEN: SECRET } },
          remote: { url: "https://remote.example/mcp" },
        },
      });
      const added = yield* codex.list(api, null);
      expect(added.connectors.map((row) => [row.name, row.scope, row.removable])).toEqual([
        ["remote", "user", true],
        ["tool", "user", true],
      ]);
      expect(JSON.stringify(added)).not.toContain(SECRET);

      yield* codex.remove(api, "tool", added.userVersion);
      yield* codex.remove(api, "remote", (yield* codex.list(api, null)).userVersion);
      expect(fake.user()).toEqual({ model: "kept", mcp_servers: {} });
      expect((yield* codex.list(api, null)).connectors).toEqual([]);
    }),
  );

  it.effect("passes on why Codex refused a write, without the values", () =>
    Effect.gen(function* () {
      const api: CodexConfigApi = {
        read: () => Effect.die("unused"),
        write: (params) =>
          Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32602,
              errorMessage: `Invalid configuration: ${JSON.stringify(params.edits[0]?.value)}`,
            }),
          ),
      };
      const error = yield* Effect.flip(
        codex.add(
          api,
          "x",
          { transport: "http", url: "https://x", headers: { Authorization: SECRET } },
          undefined,
        ),
      );
      expect(error.reason).toBe("failed");
      expect(error.message).toContain("Invalid configuration");
      expect(error.message).not.toContain(SECRET);
    }),
  );
});
