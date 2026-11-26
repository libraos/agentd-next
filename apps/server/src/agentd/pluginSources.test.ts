import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AgentdGitHubConnection from "./agentdGitHubConnection.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";
import { PLUGIN_CATALOG_URL } from "./pluginCatalog.ts";
import { gitBlobId } from "./skillCatalog.ts";

// A private catalogue (acme/private, read with a token) beside the official one, both served by a
// fake GitHub. The token is a sentinel: after everything, no request but the API's for its own
// repository carried it, and no file, log line, listing, hook or MCP launch holds it.

const TOKEN = "github_pat_SENTINEL_0123456789";
// What the server's GitHub connection gives (the App's token or the account's own): a sentinel.
const SIGN_IN = "ghs_CONNECTION_SENTINEL_9876543210";
const OFFICIAL_COMMIT = "b".repeat(40);
const PRIVATE_COMMIT = "a".repeat(40);
const PUBLIC_COMMIT = "d".repeat(40);
const OPEN_COMMIT = "e".repeat(40);
const text = (value: string) => new TextEncoder().encode(value);
const HOOK = "#!/bin/sh\ncat >/dev/null\n";

const manifest = (id: string, extra: object = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    hooks: { "before-send": { command: ["./hook.sh"] } },
    ...extra,
  });

interface Repo {
  readonly commit: string;
  readonly files: Record<string, Uint8Array>;
}

const REPOS: Record<string, Repo> = {
  "libraos/plugins": {
    commit: OFFICIAL_COMMIT,
    files: {
      "plugins/pass/agentd-plugin.json": text(manifest("pass")),
      "plugins/pass/hook.sh": text(HOOK),
    },
  },
  "acme/private": {
    commit: PRIVATE_COMMIT,
    files: {
      // Same id as the official plugin: installed beside it, never over it.
      "plugins/pass/agentd-plugin.json": text(manifest("pass", { name: "Acme pass" })),
      "plugins/pass/hook.sh": text(HOOK),
      "plugins/tools/agentd-plugin.json": text(
        JSON.stringify({
          schemaVersion: 1,
          id: "tools",
          name: "Acme tools",
          version: "1.0.0",
          contributes: { mcpServers: { acme: { command: "./server.sh", args: ["mcp"] } } },
        }),
      ),
      "plugins/tools/server.sh": text("#!/bin/sh\nexit 0\n"),
    },
  },
  // A public catalogue, read anonymously from the raw host.
  "acme/open": {
    commit: OPEN_COMMIT,
    files: {
      "plugins/open-tool/agentd-plugin.json": text(manifest("open-tool")),
      "plugins/open-tool/hook.sh": text(HOOK),
    },
  },
  "other/public": {
    commit: PUBLIC_COMMIT,
    files: {
      "elsewhere/agentd-plugin.json": text(manifest("elsewhere")),
      "elsewhere/hook.sh": text(HOOK),
    },
  },
};

const entry = (id: string, repository: string, path: string) => ({
  id,
  name: `Plugin ${id}`,
  description: "A test plugin",
  author: "Acme",
  licence: "MIT",
  reviewedAt: "2026-11-01",
  version: "1.0.0",
  source: { url: `https://github.com/${repository}`, path, sha: REPOS[repository]!.commit },
});

const OFFICIAL_CATALOG = JSON.stringify({
  version: 1,
  plugins: [entry("pass", "libraos/plugins", "plugins/pass")],
});
const PRIVATE_CATALOG = JSON.stringify({
  version: 1,
  plugins: [
    entry("pass", "acme/private", "plugins/pass"),
    entry("tools", "acme/private", "plugins/tools"),
    // Pinned in another repository: refused, as the token is for acme/private alone.
    entry("elsewhere", "other/public", "elsewhere"),
    // Its folder is not in the pinned commit's tree.
    entry("ghost", "acme/private", "plugins/ghost"),
  ],
});
const OPEN_CATALOG = JSON.stringify({
  version: 1,
  plugins: [
    entry("open-tool", "acme/open", "plugins/open-tool"),
    // Its folder is in another repository, so a link into acme/open cannot name it.
    entry("borrowed", "other/public", "elsewhere"),
  ],
});
// Catalogues that name a folder on this computer: never read, so no local plugin comes of them.
const LOCAL_CATALOGS: Record<string, string> = {
  "acme/local-path": JSON.stringify({
    version: 1,
    plugins: [
      {
        ...entry("devtool", "acme/private", "plugins/pass"),
        source: {
          url: "https://github.com/acme/local-path",
          path: "/home/me/dev-plugin",
          sha: PRIVATE_COMMIT,
        },
      },
    ],
  }),
  "acme/file-url": JSON.stringify({
    version: 1,
    plugins: [
      {
        ...entry("devtool", "acme/private", "plugins/pass"),
        source: { url: "file:///home/me/dev-plugin", path: "dev-plugin", sha: PRIVATE_COMMIT },
      },
    ],
  }),
  "acme/outside": JSON.stringify({
    version: 1,
    plugins: [
      {
        ...entry("devtool", "acme/private", "plugins/pass"),
        source: {
          url: "https://github.com/acme/outside",
          path: "../../dev-plugin",
          sha: PRIVATE_COMMIT,
        },
      },
    ],
  }),
};

const tree = (repo: Repo) =>
  JSON.stringify({
    sha: "t".repeat(40),
    truncated: false,
    tree: Object.entries(repo.files).map(([path, bytes]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: gitBlobId(bytes),
      size: bytes.byteLength,
    })),
  });

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
}

type Reply = { readonly status: number; readonly body?: string | Uint8Array; location?: string };

/** GitHub as far as the app uses it: acme/private answers only with the token, as a private repo. */
function fakeGithub(seen: Array<Seen>, tamper: { blob: boolean }) {
  const routes = new Map<string, (authorized: boolean) => Reply>();
  const ok = (body: string | Uint8Array) => () => ({ status: 200, body });
  const secret = (body: string | Uint8Array) => (authorized: boolean) =>
    authorized ? { status: 200, body } : { status: 404 };
  routes.set(PLUGIN_CATALOG_URL, ok(OFFICIAL_CATALOG));
  routes.set("https://raw.githubusercontent.com/acme/open/HEAD/catalog.json", ok(OPEN_CATALOG));
  routes.set(
    "https://api.github.com/repos/acme/private/contents/catalog.json",
    secret(PRIVATE_CATALOG),
  );
  for (const [name, catalog] of Object.entries(LOCAL_CATALOGS)) {
    routes.set(`https://api.github.com/repos/${name}/contents/catalog.json`, secret(catalog));
  }
  for (const [name, repo] of Object.entries(REPOS)) {
    const treeUrl = `https://api.github.com/repos/${name}/git/trees/${repo.commit}?recursive=1`;
    routes.set(treeUrl, name === "acme/private" ? secret(tree(repo)) : ok(tree(repo)));
    for (const [path, bytes] of Object.entries(repo.files)) {
      if (name !== "acme/private") {
        routes.set(`https://raw.githubusercontent.com/${name}/${repo.commit}/${path}`, ok(bytes));
        continue;
      }
      const sha = gitBlobId(bytes);
      const blob = `https://api.github.com/repos/${name}/git/blobs/${sha}`;
      if (path.endsWith("server.sh")) {
        // Served from another host after a redirect, which must not get the token.
        const elsewhere = `https://objects.example/blob/${sha}`;
        routes.set(blob, (authorized) =>
          authorized ? { status: 302, location: elsewhere } : { status: 404 },
        );
        // From there back to the API, which must not get it either.
        const back = `${blob}?hop=2`;
        routes.set(elsewhere, () => ({ status: 302, location: back }));
        routes.set(back, ok(bytes));
      } else {
        routes.set(blob, (authorized) =>
          authorized
            ? { status: 200, body: tamper.blob && path.endsWith("hook.sh") ? text("evil") : bytes }
            : { status: 404 },
        );
      }
    }
  }
  return HttpClient.make((request) =>
    Effect.sync(() => {
      const authorization = request.headers["authorization"];
      seen.push({ url: request.url, authorization });
      const authorized =
        authorization === `Bearer ${TOKEN}` || authorization === `Bearer ${SIGN_IN}`;
      const reply = routes.get(request.url)?.(authorized) ?? {
        status: 404,
      };
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.status === 302 ? null : (reply.body ?? ""), {
          status: reply.status,
          headers: reply.location === undefined ? {} : { location: reply.location },
        }),
      );
    }),
  );
}

const PROJECT = ProjectId.make("project-1");

/** The server's GitHub connection: the token it reads a repository with, null when none. */
interface Connection {
  token: string | null;
  /** The repositories the plugins asked it for, in order. */
  readonly asked: Array<string>;
}

const output = (stdout: string, code: number) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const seen: Array<Seen> = [];
  const tamper = { blob: false };
  const ran: Array<{ readonly cwd: string | undefined; readonly input: string }> = [];
  const connection: Connection = { token: null, asked: [] };
  const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        ran.push({ cwd: input.cwd, input: JSON.stringify(input) });
        return output(JSON.stringify({ decision: "pass" }), 0);
      }),
  });
  const github = Layer.succeed(AgentdGitHubConnection.AgentdGitHubConnection, {
    credential: (repository) =>
      Effect.sync(() => {
        connection.asked.push(repository);
        return connection.token === null
          ? Option.none()
          : Option.some(Redacted.make(connection.token));
      }),
  });
  const context = yield* Layer.build(
    AgentdPlugins.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, fakeGithub(seen, tamper)),
          Layer.succeed(HostProcess.HomeDirectory, config.baseDir),
          Layer.succeed(HostProcess.Environment, {}),
          runner,
          github,
        ),
      ),
    ),
  );
  const service = Context.get(context, AgentdPlugins.AgentdPluginsService);
  const send = service.checkBeforeSend({
    projectId: PROJECT,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    text: "hello",
    attachments: [],
    source: "web",
  });
  return { fs, path, config, secrets, service, seen, tamper, ran, send, connection };
});

const dependencies = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "agentd-plugin-sources-" })),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const PRIVATE_PASS = "gh~acme~private~pass";

it.effect("adds a private catalogue with a token, lists its plugins and removes it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const before = yield* h.service.list({});
    expect(before.sources).toEqual([
      { repository: "libraos/plugins", official: true, hasToken: false, state: "fetched" },
    ]);
    expect(before.developerMode).toBe(false);
    expect(before.plugins.map((plugin) => [plugin.id, plugin.origin])).toEqual([
      ["pass", { kind: "official" }],
    ]);

    // Without the token the private repository is not there, and nothing is saved.
    const refused = yield* h.service
      .addSource({ repository: "github.com/Acme/Private" })
      .pipe(Effect.flip);
    expect(refused.reason).toBe("githubConnection");
    expect(refused.githubConnection).toEqual({ repository: "acme/private", connected: true });
    expect((yield* h.service.list({})).sources).toHaveLength(1);

    const added = yield* h.service.addSource({
      repository: "https://github.com/Acme/Private",
      token: ` ${TOKEN} `,
    });
    // Read once when added; the listing after it is served from that read.
    expect(added.sources).toEqual([
      { repository: "libraos/plugins", official: true, hasToken: false, state: "cache" },
      { repository: "acme/private", official: false, hasToken: true, state: "cache" },
    ]);
    expect(added.plugins.map((plugin) => [plugin.id, plugin.origin])).toEqual([
      ["pass", { kind: "official" }],
      ["gh~acme~private~elsewhere", { kind: "github", repository: "acme/private" }],
      ["gh~acme~private~ghost", { kind: "github", repository: "acme/private" }],
      [PRIVATE_PASS, { kind: "github", repository: "acme/private" }],
      ["gh~acme~private~tools", { kind: "github", repository: "acme/private" }],
    ]);

    const official = yield* h.service
      .removeSource({ repository: "libraos/plugins" })
      .pipe(Effect.flip);
    expect(official.reason).toBe("invalid");
    expect(
      (yield* h.service.addSource({ repository: "libraos/plugins" }).pipe(Effect.flip)).reason,
    ).toBe("invalid");

    yield* h.service.install({ id: PRIVATE_PASS });
    yield* h.service.setEnabled({ id: PRIVATE_PASS, enabled: true });
    const tokenFile = h.path.join(h.config.secretsDir, "agentd-plugin-source.gh~acme~private.bin");
    expect(yield* h.fs.exists(tokenFile)).toBe(true);

    // The token file goes; the plugin installed from it stays, runs, and says its source is gone.
    const removed = yield* h.service.removeSource({ repository: "acme/private" });
    expect(removed.sources.map((source) => source.repository)).toEqual(["libraos/plugins"]);
    expect(yield* h.fs.exists(tokenFile)).toBe(false);
    expect(
      yield* h.secrets.get("agentd-plugin-source.gh~acme~private").pipe(Effect.map((v) => v._tag)),
    ).toBe("None");
    expect(
      removed.plugins.map((plugin) => [plugin.id, plugin.installedVersion, plugin.sourceRemoved]),
    ).toEqual([
      ["pass", undefined, undefined],
      [PRIVATE_PASS, "1.0.0", true],
    ]);
    expect(removed.plugins[1]).toMatchObject({ enabled: true, state: "on" });
    expect((yield* h.service.install({ id: PRIVATE_PASS }).pipe(Effect.flip)).message).toContain(
      "no longer a source",
    );
    yield* h.send;
    expect(h.ran).toHaveLength(1);

    // Added again, it is a source's plugin once more.
    const again = yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
    expect(again.plugins.find((plugin) => plugin.id === PRIVATE_PASS)?.sourceRemoved).toBe(
      undefined,
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect("installs a private plugin checked file by file against its pinned commit", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.service.addSource({ repository: "acme/private", token: TOKEN });

    h.tamper.blob = true;
    const tampered = yield* h.service.install({ id: PRIVATE_PASS }).pipe(Effect.flip);
    expect(tampered.message).toContain(`does not match commit ${PRIVATE_COMMIT}`);
    const cache = h.path.join(h.config.stateDir, "plugins", "cache");
    expect(yield* h.fs.exists(h.path.join(cache, "gh~acme~private", PRIVATE_PASS, "1.0.0"))).toBe(
      false,
    );

    h.tamper.blob = false;
    const listed = yield* h.service.install({ id: PRIVATE_PASS });
    expect(listed.plugins.find((plugin) => plugin.id === PRIVATE_PASS)).toMatchObject({
      name: "Acme pass",
      installedVersion: "1.0.0",
      state: "off",
    });
    const folder = h.path.join(cache, "gh~acme~private", PRIVATE_PASS, "1.0.0");
    const record = JSON.parse(
      yield* h.fs.readFileString(h.path.join(folder, ".agentd-plugin-install.json")),
    );
    expect(record).toMatchObject({
      id: "pass",
      repository: "acme/private",
      commit: PRIVATE_COMMIT,
    });
    expect(((yield* h.fs.stat(h.path.join(folder, "hook.sh"))).mode & 0o111) !== 0).toBe(true);
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "a private plugin with an official plugin's id installs beside it and changes nothing of it",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.service.install({ id: "pass" });
      yield* h.service.setEnabled({ id: "pass", enabled: true });
      const officialFolder = h.path.join(
        h.config.stateDir,
        "plugins",
        "cache",
        "libraos",
        "pass",
        "1.0.0",
      );
      const officialManifest = yield* h.fs.readFileString(
        h.path.join(officialFolder, "agentd-plugin.json"),
      );

      yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
      const listed = yield* h.service.install({ id: PRIVATE_PASS });
      expect(
        listed.plugins
          .filter((plugin) => plugin.id === "pass" || plugin.id === PRIVATE_PASS)
          .map((plugin) => [plugin.id, plugin.name, plugin.enabled]),
      ).toEqual([
        ["pass", "Plugin pass", true],
        [PRIVATE_PASS, "Acme pass", false],
      ]);
      expect(yield* h.fs.readFileString(h.path.join(officialFolder, "agentd-plugin.json"))).toBe(
        officialManifest,
      );

      // Removing the private copy leaves the official one installed and on.
      const removed = yield* h.service.remove({ id: PRIVATE_PASS });
      expect(removed.plugins.find((plugin) => plugin.id === "pass")).toMatchObject({
        installedVersion: "1.0.0",
        enabled: true,
        state: "on",
      });
      yield* h.send;
      expect(h.ran.map((run) => run.cwd)).toEqual([officialFolder]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("the token goes only to the API for its own repository and is kept nowhere else", () =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make((options) => {
      logs.push(JSON.stringify(options.message), String(options.cause));
    });
    yield* Effect.gen(function* () {
      const h = yield* harness;
      const wrong = yield* h.service
        .addSource({ repository: "acme/private", token: `${TOKEN}-wrong` })
        .pipe(Effect.flip);
      expect(wrong.message).not.toContain(TOKEN);

      const listings = [yield* h.service.addSource({ repository: "acme/private", token: TOKEN })];
      for (const id of [PRIVATE_PASS, "gh~acme~private~tools"]) {
        listings.push(yield* h.service.install({ id }));
        listings.push(yield* h.service.setEnabled({ id, enabled: true }));
      }
      listings.push(yield* h.service.list({ projectId: PROJECT }));
      yield* h.send;
      const servers = yield* h.service.mcpServers(PROJECT);
      expect(Object.keys(servers)).toEqual(["acme"]);

      const carried = h.seen.filter((request) => request.authorization !== undefined);
      expect(carried.length).toBeGreaterThan(0);
      for (const request of carried) {
        expect(request.url).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/private\//);
      }
      // The redirect to another host was followed, without the token.
      expect(
        h.seen.filter(
          (request) =>
            request.url.startsWith("https://objects.example/") || request.url.endsWith("?hop=2"),
        ),
      ).toEqual([
        expect.objectContaining({ authorization: undefined }),
        expect.objectContaining({ authorization: undefined }),
      ]);
      const failures = [
        yield* h.service.install({ id: "gh~acme~private~elsewhere" }).pipe(Effect.flip),
        yield* h.service.install({ id: "gh~acme~private~ghost" }).pipe(Effect.flip),
      ];
      expect(JSON.stringify(failures)).not.toContain(TOKEN);

      expect(JSON.stringify(listings)).not.toContain(TOKEN);
      expect(JSON.stringify(servers)).not.toContain(TOKEN);
      expect(h.ran.length).toBeGreaterThan(0);
      expect(JSON.stringify(h.ran)).not.toContain(TOKEN);

      // Only the secret store holds it, in a file only this user can read.
      const found: Array<string> = [];
      const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          for (const name of yield* h.fs.readDirectory(dir)) {
            const file = h.path.join(dir, name);
            if (file === h.config.secretsDir) continue;
            const info = yield* h.fs.stat(file);
            if (info.type === "Directory") yield* walk(file);
            else if ((yield* h.fs.readFileString(file)).includes(TOKEN)) found.push(file);
          }
        });
      yield* walk(h.config.stateDir);
      expect(found).toEqual([]);
      const secretFile = h.path.join(
        h.config.secretsDir,
        "agentd-plugin-source.gh~acme~private.bin",
      );
      expect((yield* h.fs.stat(secretFile)).mode & 0o777).toBe(0o600);
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
    expect(logs.join("\n")).not.toContain(TOKEN);
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "an install from before sources keeps listing, running and its settings and secrets",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      // The layout the previous version wrote, by hand.
      const plugins = path.join(config.stateDir, "plugins");
      const folder = path.join(plugins, "cache", "libraos", "legacy", "0.9.0");
      const legacyManifest = JSON.stringify({
        schemaVersion: 1,
        id: "legacy",
        name: "Legacy",
        version: "0.9.0",
        hooks: { "before-send": { command: ["./hook.sh"] } },
        settings: [
          { name: "url", label: "URL", secret: false },
          { name: "api_key", label: "API key", secret: true },
        ],
        contributes: {
          mcpServers: {
            legacy: {
              command: "./hook.sh",
              args: [],
              settings: { LEGACY_URL: "url", LEGACY_KEY_FILE: { setting: "api_key", file: true } },
            },
          },
        },
      });
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "agentd-plugin.json"), legacyManifest);
      yield* fs.writeFileString(path.join(folder, "hook.sh"), HOOK);
      yield* fs.writeFileString(
        path.join(folder, ".agentd-plugin-install.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "legacy",
          version: "0.9.0",
          repository: "libraos/plugins",
          commit: OFFICIAL_COMMIT,
          path: "plugins/legacy",
          installedAt: "2026-11-01T00:00:00.000Z",
          files: ["agentd-plugin.json", "hook.sh"],
        }),
      );
      yield* fs.writeFileString(
        path.join(plugins, "settings.json"),
        JSON.stringify({
          enabled: { legacy: true },
          projects: { [PROJECT]: { legacy: true } },
          values: { legacy: { url: "https://legacy.example" } },
        }),
      );
      yield* secrets.set("agentd-plugin.legacy.api_key", text("legacy-secret"));

      const h = yield* harness;
      const listed = yield* h.service.list({ projectId: PROJECT });
      expect(listed.plugins.find((plugin) => plugin.id === "legacy")).toMatchObject({
        origin: { kind: "official" },
        installedVersion: "0.9.0",
        enabled: true,
        projectEnabled: true,
        state: "on",
        settings: [
          { name: "url", value: "https://legacy.example", set: true },
          { name: "api_key", set: true },
        ],
      });
      expect(listed.beforeSend).toBe(true);
      yield* h.send;
      expect(h.ran.map((run) => run.cwd)).toEqual([folder]);
      const servers = yield* h.service.mcpServers(PROJECT);
      expect(servers.legacy?.env.LEGACY_URL).toBe("https://legacy.example");
      expect(yield* fs.readFileString(servers.legacy!.env.LEGACY_KEY_FILE!)).toBe("legacy-secret");
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "developer mode is off by default; on, a local folder is checked, marked Local and run",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const good = h.path.join(h.config.baseDir, "dev-plugin");
      yield* h.fs.makeDirectory(good, { recursive: true });
      yield* h.fs.writeFileString(h.path.join(good, "agentd-plugin.json"), manifest("devtool"));
      yield* h.fs.writeFileString(h.path.join(good, "hook.sh"), HOOK);
      const bad = h.path.join(h.config.baseDir, "bad-plugin");
      yield* h.fs.makeDirectory(bad, { recursive: true });
      yield* h.fs.writeFileString(
        h.path.join(bad, "agentd-plugin.json"),
        JSON.stringify({ schemaVersion: 1, id: "devtool", name: "Bad", surprise: true }),
      );

      expect((yield* h.service.list({})).developerMode).toBe(false);
      const off = yield* h.service.addLocal({ path: good }).pipe(Effect.flip);
      expect(off.message).toContain("developer mode");

      yield* h.service.setDeveloperMode({ enabled: true });
      const refused = yield* h.service.addLocal({ path: bad }).pipe(Effect.flip);
      expect(refused.reason).toBe("invalid");
      expect(refused.message).toContain("is refused");
      expect(refused.message).toContain("surprise");
      expect(refused.message).toContain('["version"]');
      expect(
        (yield* h.service.addLocal({ path: "relative/folder" }).pipe(Effect.flip)).reason,
      ).toBe("invalid");

      const added = yield* h.service.addLocal({ path: good });
      const real = yield* h.fs.realPath(good);
      expect(added.plugins.find((plugin) => plugin.id === "local~devtool")).toMatchObject({
        origin: { kind: "local", path: real },
        installedVersion: "1.0.0",
        state: "off",
      });
      expect((yield* h.service.install({ id: "local~devtool" }).pipe(Effect.flip)).reason).toBe(
        "invalid",
      );
      yield* h.service.setEnabled({ id: "local~devtool", enabled: true });
      yield* h.send;
      expect(h.ran.map((run) => run.cwd)).toEqual([real]);

      // Read again on demand: a manifest broken since is listed with why, and not run.
      yield* h.fs.writeFileString(h.path.join(good, "agentd-plugin.json"), "{");
      const broken = yield* h.service.list({});
      expect(broken.plugins.find((plugin) => plugin.id === "local~devtool")?.problems?.length).toBe(
        1,
      );
      yield* h.fs.writeFileString(h.path.join(good, "agentd-plugin.json"), manifest("devtool"));

      // Off again: the local plugin is neither listed nor run, and sends go on.
      const hidden = yield* h.service.setDeveloperMode({ enabled: false });
      expect(hidden.plugins.map((plugin) => plugin.id)).toEqual(["pass"]);
      expect(yield* h.service.hasBeforeSend(PROJECT)).toBe(false);
      yield* h.send;
      expect(h.ran).toHaveLength(1);
      // The folder itself is the developer's: removing the plugin leaves it.
      yield* h.service.setDeveloperMode({ enabled: true });
      yield* h.service.remove({ id: "local~devtool" });
      expect(yield* h.fs.exists(h.path.join(good, "hook.sh"))).toBe(true);
      expect((yield* h.service.list({})).plugins.map((plugin) => plugin.id)).toEqual(["pass"]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "refuses a private entry in another repository or outside its commit's tree, writing nothing",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
      const cache = h.path.join(h.config.stateDir, "plugins", "cache", "gh~acme~private");

      const elsewhere = yield* h.service
        .install({ id: "gh~acme~private~elsewhere" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("invalid");
      expect(elsewhere.message).toContain("pinned in other/public, not in acme/private");
      // Nothing was asked of the other repository, with the token or without it.
      expect(h.seen.filter((request) => request.url.includes("other/public"))).toEqual([]);

      const ghost = yield* h.service.install({ id: "gh~acme~private~ghost" }).pipe(Effect.flip);
      expect(ghost.reason).toBe("download");
      expect(ghost.message).toContain(
        `plugins/ghost/agentd-plugin.json is not in commit ${PRIVATE_COMMIT}`,
      );
      expect(yield* h.fs.exists(cache)).toBe(false);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("a catalogue cannot add a local folder, even with developer mode on", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const folder = h.path.join(h.config.baseDir, "dev-plugin");
    yield* h.fs.makeDirectory(folder, { recursive: true });
    yield* h.fs.writeFileString(h.path.join(folder, "agentd-plugin.json"), manifest("devtool"));
    yield* h.fs.writeFileString(h.path.join(folder, "hook.sh"), HOOK);
    yield* h.service.setDeveloperMode({ enabled: true });

    for (const repository of Object.keys(LOCAL_CATALOGS)) {
      const refused = yield* h.service.addSource({ repository, token: TOKEN }).pipe(Effect.flip);
      expect(refused.message).toContain("not a plugin catalogue");
    }
    const listed = yield* h.service.list({});
    expect(listed.sources.map((source) => source.repository)).toEqual(["libraos/plugins"]);
    expect(listed.plugins.map((plugin) => [plugin.id, plugin.origin.kind])).toEqual([
      ["pass", "official"],
    ]);
    const sources = JSON.parse(
      yield* h.fs.readFileString(h.path.join(h.config.stateDir, "plugins", "sources.json")),
    );
    expect(sources.local).toEqual([]);
    yield* h.send;
    expect(h.ran).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

type Harness = Effect.Success<typeof harness>;

/** Every file under `dir` whose text holds `needle`. */
const filesHolding = (h: Harness, dir: string, needle: string) =>
  Effect.gen(function* () {
    const found: Array<string> = [];
    const walk = (at: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        for (const name of yield* h.fs.readDirectory(at)) {
          const file = h.path.join(at, name);
          const info = yield* h.fs.stat(file);
          if (info.type === "Directory") yield* walk(file);
          else if ((yield* h.fs.readFileString(file)).includes(needle)) found.push(file);
        }
      });
    yield* walk(dir);
    return found;
  });

const readSourcesFile = (h: Harness) =>
  h.fs
    .readFileString(h.path.join(h.config.stateDir, "plugins", "sources.json"))
    .pipe(Effect.map((text) => JSON.parse(text)));

it.effect(
  "a pasted repository, catalog.json or plugin folder link adds the source; a plugin link names its plugin",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      for (const link of [
        "https://github.com/Acme/Open",
        "github.com/acme/open/",
        "https://github.com/acme/open.git",
        "https://github.com/acme/open/tree/main",
        "https://github.com/acme/open/blob/main/catalog.json",
        "https://raw.githubusercontent.com/acme/open/refs/heads/main/catalog.json",
      ]) {
        const added = yield* h.service.addSource({ repository: link });
        expect(added.sources.map((source) => [source.repository, source.hasToken])).toEqual([
          ["libraos/plugins", false],
          ["acme/open", false],
        ]);
        expect(added.linked).toBeUndefined();
        yield* h.service.removeSource({ repository: "acme/open" });
      }

      // A plugin folder's link, with a branch name that holds a slash.
      for (const link of [
        "https://github.com/acme/open/tree/main/plugins/open-tool",
        "github.com/acme/open/tree/feature/next/plugins/open-tool/?tab=readme#top",
      ]) {
        const added = yield* h.service.addSource({ repository: link });
        expect(added.linked).toBe("gh~acme~open~open-tool");
        expect(added.sources.map((source) => source.repository)).toEqual([
          "libraos/plugins",
          "acme/open",
        ]);
      }
      // The install is the catalogue's pinned commit, whatever branch the link named.
      const installed = yield* h.service.install({ id: "gh~acme~open~open-tool" });
      expect(
        installed.plugins.find((plugin) => plugin.id === "gh~acme~open~open-tool"),
      ).toMatchObject({ installedVersion: "1.0.0", origin: { kind: "github" } });
      const record = JSON.parse(
        yield* h.fs.readFileString(
          h.path.join(
            h.config.stateDir,
            "plugins",
            "cache",
            "gh~acme~open",
            "gh~acme~open~open-tool",
            "1.0.0",
            ".agentd-plugin-install.json",
          ),
        ),
      );
      expect(record.commit).toBe(OPEN_COMMIT);

      // An official plugin's link opens its install without adding a source.
      const official = yield* h.service.addSource({
        repository: "https://github.com/libraos/plugins/tree/main/plugins/pass",
      });
      expect(official.linked).toBe("pass");
      expect(official.sources).toHaveLength(2);
      // Public sources are read anonymously; the GitHub connection was never asked.
      expect(h.connection.asked).toEqual([]);
      expect(h.seen.every((request) => request.authorization === undefined)).toBe(true);
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "refuses a link to no plugin of the catalogue, one pinned elsewhere, and anything not GitHub",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.service.setDeveloperMode({ enabled: true });
      const missing = yield* h.service
        .addSource({ repository: "https://github.com/acme/open/tree/main/plugins/nope" })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("unknown");
      expect(missing.message).toContain("no plugin in the folder that link names");
      // The catalogue lists borrowed, but its folder is in other/public, not acme/open.
      const elsewhere = yield* h.service
        .addSource({ repository: "https://github.com/acme/open/tree/main/elsewhere" })
        .pipe(Effect.flip);
      expect(elsewhere.reason).toBe("invalid");
      expect(elsewhere.message).toContain("pinned in other/public, not in acme/open");
      expect(
        (yield* h.service
          .addSource({ repository: "https://github.com/libraos/plugins/tree/main/plugins/nope" })
          .pipe(Effect.flip)).reason,
      ).toBe("unknown");

      const folder = h.path.join(h.config.baseDir, "dev-plugin");
      yield* h.fs.makeDirectory(folder, { recursive: true });
      yield* h.fs.writeFileString(h.path.join(folder, "agentd-plugin.json"), manifest("devtool"));
      for (const link of [
        folder,
        `file://${folder}`,
        "~/dev-plugin",
        "./dev-plugin",
        "C:\\Users\\me\\dev-plugin",
        "\\\\server\\share\\dev-plugin",
        "https://gitlab.com/acme/open",
        "https://github.com.evil.example/acme/open",
        "http://github.com/acme/open",
        "https://me@github.com/acme/open",
        "https://github.com/acme/open/issues/1",
        "https://github.com/acme/open/blob/main/plugins/open-tool/hook.sh",
      ]) {
        const refused = yield* h.service.addSource({ repository: link }).pipe(Effect.flip);
        expect([link, refused.reason]).toEqual([link, "invalid"]);
      }
      const listed = yield* h.service.list({});
      expect(listed.sources.map((source) => source.repository)).toEqual(["libraos/plugins"]);
      expect(listed.plugins.map((plugin) => plugin.origin.kind)).toEqual(["official"]);
      const sources = yield* readSourcesFile(h);
      expect(sources).toMatchObject({ github: [], local: [] });
      expect(
        yield* h.fs.exists(
          h.path.join(h.config.stateDir, "plugins", "catalogs", "gh~acme~open.json"),
        ),
      ).toBe(false);
      expect(h.connection.asked).toEqual([]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "a private repository reads with the GitHub connection once confirmed for that source",
  () =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const capture = Logger.make((options) => {
        logs.push(JSON.stringify(options.message), String(options.cause));
      });
      yield* Effect.gen(function* () {
        const h = yield* harness;
        h.connection.token = SIGN_IN;
        const link = "https://github.com/acme/private/tree/main/plugins/pass";

        // Asked first; the connection is not read before the confirm.
        const asked = yield* h.service.addSource({ repository: link }).pipe(Effect.flip);
        expect(asked.reason).toBe("githubConnection");
        expect(asked.githubConnection).toEqual({ repository: "acme/private", connected: true });
        expect(h.connection.asked).toEqual([]);
        expect((yield* h.service.list({})).sources).toHaveLength(1);

        const added = yield* h.service.addSource({ repository: link, useGitHubConnection: true });
        expect(added.linked).toBe(PRIVATE_PASS);
        expect(added.sources[1]).toEqual({
          repository: "acme/private",
          official: false,
          hasToken: false,
          githubConnection: true,
          state: "cache",
        });
        expect(h.connection.asked).toEqual(["acme/private"]);
        expect(yield* readSourcesFile(h)).toMatchObject({
          github: [{ repository: "acme/private", githubConnection: true }],
        });

        // Asked again for each fetch, without asking the person again.
        const listings = [added];
        for (const id of [PRIVATE_PASS, "gh~acme~private~tools"]) {
          listings.push(yield* h.service.install({ id }));
          listings.push(yield* h.service.setEnabled({ id, enabled: true }));
        }
        expect(h.connection.asked).toEqual(["acme/private", "acme/private", "acme/private"]);
        // The plugin's own link, pasted again, needs no confirm for a source already confirmed.
        listings.push(yield* h.service.addSource({ repository: link }));
        listings.push(yield* h.service.list({ projectId: PROJECT }));
        yield* h.send;
        const servers = yield* h.service.mcpServers(PROJECT);

        // Sent only to the API for that repository, and never across the redirect.
        const carried = h.seen.filter((request) => request.authorization !== undefined);
        expect(carried.length).toBeGreaterThan(0);
        for (const request of carried) {
          expect(request.url).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/private\//);
          expect(request.authorization).toBe(`Bearer ${SIGN_IN}`);
        }
        expect(
          h.seen.filter(
            (request) =>
              request.url.startsWith("https://objects.example/") || request.url.endsWith("?hop=2"),
          ),
        ).toEqual([
          expect.objectContaining({ authorization: undefined }),
          expect.objectContaining({ authorization: undefined }),
        ]);

        // Confirmed for acme/private only: another repository is asked about, not read with it.
        const before = h.connection.asked.length;
        const other = yield* h.service
          .addSource({ repository: "acme/local-path" })
          .pipe(Effect.flip);
        expect(other.reason).toBe("githubConnection");
        expect(h.connection.asked.length).toBe(before);

        // Kept nowhere: not the secret store, sources.json, the catalogue cache, a listing,
        // a hook, an MCP launch, an error or a log line.
        const failures = [
          yield* h.service.install({ id: "gh~acme~private~elsewhere" }).pipe(Effect.flip),
          yield* h.service.install({ id: "gh~acme~private~ghost" }).pipe(Effect.flip),
        ];
        expect(yield* filesHolding(h, h.config.baseDir, SIGN_IN)).toEqual([]);
        expect(
          yield* h.secrets
            .get("agentd-plugin-source.gh~acme~private")
            .pipe(Effect.map((v) => v._tag)),
        ).toBe("None");
        expect(JSON.stringify([listings, failures, servers, h.ran])).not.toContain(SIGN_IN);
        expect(h.ran.length).toBeGreaterThan(0);

        // Removed, it is asked about again before the connection is read.
        yield* h.service.removeSource({ repository: "acme/private" });
        const again = h.connection.asked.length;
        expect((yield* h.service.addSource({ repository: link }).pipe(Effect.flip)).reason).toBe(
          "githubConnection",
        );
        expect(h.connection.asked.length).toBe(again);
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
      expect(logs.join("\n")).not.toContain(SIGN_IN);
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "with no GitHub connection the error says to sign in or run gh auth login; a token still works",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const none = yield* h.service
        .addSource({ repository: "acme/private", useGitHubConnection: true })
        .pipe(Effect.flip);
      expect(none.reason).toBe("githubConnection");
      expect(none.githubConnection).toEqual({ repository: "acme/private", connected: false });
      expect(none.message).toContain("run gh auth login");
      expect((yield* h.service.list({})).sources).toHaveLength(1);

      // A connection that cannot read the repository says so, and the credential is not in it.
      h.connection.token = "ghs_WRONG_ACCOUNT_000000";
      const wrong = yield* h.service
        .addSource({ repository: "acme/private", useGitHubConnection: true })
        .pipe(Effect.flip);
      expect(wrong.message).toContain("could not be read with your GitHub connection");
      expect(wrong.message).not.toContain("ghs_WRONG_ACCOUNT");

      const added = yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
      expect(added.sources[1]).toEqual({
        repository: "acme/private",
        official: false,
        hasToken: true,
        state: "cache",
      });
      yield* h.service.install({ id: PRIVATE_PASS });
      // A source with a token never asks the connection.
      expect(h.connection.asked).toEqual(["acme/private", "acme/private"]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("switching a source between a token and the connection keeps one way of reading it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.connection.token = SIGN_IN;
    yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
    const connected = yield* h.service.addSource({
      repository: "acme/private",
      useGitHubConnection: true,
    });
    expect(connected.sources[1]).toMatchObject({ hasToken: false, githubConnection: true });
    expect(
      yield* h.secrets.get("agentd-plugin-source.gh~acme~private").pipe(Effect.map((v) => v._tag)),
    ).toBe("None");
    const token = yield* h.service.addSource({ repository: "acme/private", token: TOKEN });
    expect(token.sources[1]).toEqual({
      repository: "acme/private",
      official: false,
      hasToken: true,
      state: "cache",
    });
    expect(yield* readSourcesFile(h)).toMatchObject({ github: [{ repository: "acme/private" }] });
    expect((yield* readSourcesFile(h)).github[0].githubConnection).toBeUndefined();
  }).pipe(Effect.provide(dependencies)),
);
