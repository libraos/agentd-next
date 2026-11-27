import { describe, expect, it } from "@effect/vitest";

import {
  definitionOfManifest,
  expandMcpServer,
  parseClaudePlugin,
  parseMarketplace,
  type ExpandContext,
} from "./claudePluginFormat.ts";

const plugin = (extra: object = {}) =>
  JSON.stringify({ name: "outreach", version: "0.2.0", displayName: "Outreach mailer", ...extra });

const userConfig = {
  outreach_url: { type: "string", title: "Outreach URL" },
  outreach_token_file: { type: "string", title: "Project API token" },
};
const mcp = JSON.stringify({
  mcpServers: {
    outreach: {
      command: "outreach",
      args: ["mcp"],
      env: {
        OUTREACH_URL: "${user_config.outreach_url}",
        OUTREACH_API_KEY_FILE: "${user_config.outreach_token_file}",
      },
    },
  },
});
const sidecar = JSON.stringify({
  schemaVersion: 2,
  setup: { command: ["python3", "check_outreach.py"], description: "Checks outreach." },
  secretFiles: ["outreach_token_file"],
});

const context = (settings: Record<string, string>): ExpandContext => ({
  root: "/plugins/outreach",
  data: "/data/outreach",
  setting: (name) => settings[name],
  env: (name) => ({ HOME: "/home/me" })[name],
});

const reasons = (files: Parameters<typeof parseClaudePlugin>[0]) => {
  const parsed = parseClaudePlugin(files);
  return parsed._tag === "Invalid" ? parsed.reasons : [];
};

describe("parseClaudePlugin", () => {
  it("reads a Claude plugin folder with its sidecar as one plugin", () => {
    const parsed = parseClaudePlugin({ plugin: plugin({ userConfig }), mcp, sidecar });
    expect(parsed).toMatchObject({
      _tag: "Valid",
      plugin: {
        id: "outreach",
        name: "Outreach mailer",
        version: "0.2.0",
        claude: true,
        setup: { command: ["python3", "check_outreach.py"] },
        settings: [
          { name: "outreach_url", label: "Outreach URL", secret: false },
          { name: "outreach_token_file", label: "Project API token", secret: true },
        ],
      },
    });
  });

  it("reads a bare map of servers and ignores keys Claude adds", () => {
    const parsed = parseClaudePlugin({
      plugin: plugin({ keywords: ["mail"], homepage: "https://example.test" }),
      mcp: JSON.stringify({ docs: { type: "http", url: "https://example.test/mcp" } }),
    });
    expect(parsed._tag === "Valid" && Object.keys(parsed.plugin.mcpServers)).toEqual(["docs"]);
  });

  it.each([
    ["a plugin without a version", { plugin: JSON.stringify({ name: "outreach" }) }, "version"],
    ["a name that is not an id", { plugin: plugin({ name: "Out Reach" }) }, "name"],
    [
      "a command outside the plugin's folder",
      { plugin: plugin(), mcp: JSON.stringify({ a: { command: "/usr/bin/evil" } }) },
      "mcpServers.a.command",
    ],
    [
      "a command that leaves the folder through the root",
      {
        plugin: plugin(),
        mcp: JSON.stringify({ a: { command: "${CLAUDE_PLUGIN_ROOT}/../evil" } }),
      },
      "mcpServers.a.command",
    ],
    [
      "a server name with a dot",
      { plugin: plugin(), mcp: JSON.stringify({ "a.b": { command: "x" } }) },
      "mcpServers: a.b",
    ],
    [
      "an option the plugin does not declare",
      { plugin: plugin(), mcp },
      "outreach_url is not a userConfig option",
    ],
    [
      "a sensitive option in a server's config",
      {
        plugin: plugin({
          userConfig: { ...userConfig, outreach_url: { sensitive: true } },
        }),
        mcp,
      },
      "outreach_url is sensitive",
    ],
    [
      "a secret file that is not an option",
      { plugin: plugin(), sidecar: JSON.stringify({ schemaVersion: 2, secretFiles: ["nope"] }) },
      "secretFiles: nope",
    ],
    [
      "a sidecar field the app does not know",
      { plugin: plugin(), sidecar: JSON.stringify({ schemaVersion: 2, later: true }) },
      "agentd-plugin.json",
    ],
  ])("refuses %s", (_name, files, reason) => {
    expect(reasons(files).join("\n")).toContain(reason);
  });
});

describe("expandMcpServer", () => {
  const parsed = parseClaudePlugin({ plugin: plugin({ userConfig }), mcp, sidecar });
  const server = parsed._tag === "Valid" ? parsed.plugin.mcpServers.outreach! : null;

  it("fills settings, the plugin's folders and the environment", () => {
    expect(
      expandMcpServer(
        {
          command: "${CLAUDE_PLUGIN_ROOT}/run.py",
          args: ["--data", "${CLAUDE_PLUGIN_DATA}", "--home=${HOME}", "${NOPE:-fallback}"],
          env: { URL: "${user_config.outreach_url}/v1" },
        },
        context({ outreach_url: "https://o.test" }),
      ),
    ).toEqual({
      _tag: "Stdio",
      command: "/plugins/outreach/run.py",
      args: ["--data", "/data/outreach", "--home=/home/me", "fallback"],
      env: { URL: "https://o.test/v1" },
    });
  });

  it("leaves a server out while a setting it names has no value", () => {
    expect(expandMcpServer(server!, context({ outreach_url: "https://o.test" }))).toEqual({
      _tag: "Missing",
      settings: ["outreach_token_file"],
    });
  });

  it("marks a remote server that names its own OAuth client", () => {
    expect(
      expandMcpServer(
        {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${TOKEN:-none}" },
          oauth: { clientId: "abc" },
        },
        context({}),
      ),
    ).toEqual({
      _tag: "Remote",
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer none" },
      oauthClient: true,
    });
  });
});

describe("definitionOfManifest", () => {
  it("turns a version 1 manifest's settings into variables", () => {
    const definition = definitionOfManifest({
      schemaVersion: 1,
      id: "legal",
      name: "Legal",
      version: "0.2.2",
      settings: [{ name: "token", label: "Token", secret: true }],
      contributes: {
        mcpServers: {
          legal: {
            command: "./legal_mcp.py",
            args: [],
            env: { MODE: "x" },
            settings: { TOKEN_FILE: { setting: "token", file: true } },
          },
        },
      },
    });
    expect(definition.claude).toBe(false);
    expect(
      expandMcpServer(definition.mcpServers.legal!, context({ token: "/secrets/token" })),
    ).toEqual({
      _tag: "Stdio",
      command: "/plugins/outreach/legal_mcp.py",
      args: [],
      env: { MODE: "x", TOKEN_FILE: "/secrets/token" },
    });
  });
});

describe("parseMarketplace", () => {
  const sha = "a".repeat(40);
  const entry = (extra: object = {}) => ({
    name: "outreach",
    version: "0.2.0",
    description: "Mailer",
    author: { name: "LibraOS" },
    license: "MIT",
    source: {
      source: "git-subdir",
      url: "https://github.com/libraos/plugins.git",
      path: "plugins/outreach",
      sha,
    },
    libraos: { reviewedAt: "2026-11-27", notices: ["LICENSE"] },
    ...extra,
  });
  const read = (plugins: ReadonlyArray<object>) =>
    parseMarketplace(JSON.stringify({ name: "libraos", owner: { name: "LibraOS" }, plugins }));

  it("lists an entry pinned to a commit as a catalogue entry", () => {
    expect(read([entry()])).toEqual({
      version: 1,
      plugins: [
        {
          id: "outreach",
          name: "outreach",
          description: "Mailer",
          author: "LibraOS",
          licence: "MIT",
          reviewedAt: "2026-11-27",
          version: "0.2.0",
          source: {
            url: "https://github.com/libraos/plugins",
            path: "plugins/outreach",
            sha,
            notices: ["LICENSE"],
          },
        },
      ],
    });
  });

  it("leaves out entries it cannot pin or place safely", () => {
    const listed = read([
      entry({ name: "relative", source: "./plugins/relative" }),
      entry({ name: "branch", source: { source: "github", repo: "a/b", ref: "main" } }),
      entry({ name: "escapes", source: { ...entry().source, path: "../elsewhere" } }),
      entry({ name: "unversioned", version: undefined }),
      entry(),
    ]);
    expect(listed?.plugins.map((plugin) => plugin.id)).toEqual(["outreach"]);
  });

  it("is not a catalogue when a name repeats or the file is something else", () => {
    expect(read([entry(), entry()])).toBeNull();
    expect(parseMarketplace(JSON.stringify({ version: 1, plugins: [] }))).toBeNull();
  });
});
