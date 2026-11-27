import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  HookCommand,
  PLUGIN_MANIFEST_FILE,
  SetupCommand,
  parsePluginManifest,
  resolveHookCommand,
  validPluginId,
  validPluginVersion,
  PluginCatalogEntry,
  type PluginCatalog,
  type PluginManifest,
} from "./pluginCatalog.ts";

// A plugin in Claude Code's format: `.claude-plugin/plugin.json`, `.mcp.json`, and a catalogue as
// `.claude-plugin/marketplace.json`. What Claude has no word for (the before-send hook, setup, a
// secret kept as a file) is in the sidecar `agentd-plugin.json`, which Claude never reads.

export const CLAUDE_PLUGIN_FILE = ".claude-plugin/plugin.json";
export const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
export const CLAUDE_MCP_FILE = ".mcp.json";

const SETTING_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// No dots: Codex splits its config override keys on every dot.
const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const Author = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const authorName = (author: typeof Author.Type | undefined) =>
  author === undefined ? "" : typeof author === "string" ? author : author.name;

const UserConfigOption = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  sensitive: Schema.optionalKey(Schema.Boolean),
  required: Schema.optionalKey(Schema.Boolean),
});

// Keys Claude adds later are ignored, as Claude ignores ours.
const ClaudePluginJson = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Author),
  license: Schema.optionalKey(Schema.String),
  userConfig: Schema.optionalKey(Schema.Record(Schema.String, UserConfigOption)),
});

const StringRecord = Schema.Record(Schema.String, Schema.String);

const StdioServer = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("stdio")),
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(StringRecord),
});
const RemoteServer = Schema.Struct({
  type: Schema.Literals(["http", "sse"]),
  url: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.optionalKey(StringRecord),
  oauth: Schema.optionalKey(
    Schema.Struct({
      clientId: Schema.optionalKey(Schema.String),
      callbackPort: Schema.optionalKey(Schema.Number),
    }),
  ),
});
/** One server of a `.mcp.json`, its strings still holding `${...}` variables. */
export const ClaudeMcpServer = Schema.Union([RemoteServer, StdioServer]);
export type ClaudeMcpServer = typeof ClaudeMcpServer.Type;

const McpServers = Schema.Record(Schema.String, ClaudeMcpServer);
const WrappedMcpJson = Schema.Struct({ mcpServers: McpServers });

const Sidecar = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  hooks: Schema.optionalKey(Schema.Struct({ "before-send": Schema.optionalKey(HookCommand) })),
  setup: Schema.optionalKey(SetupCommand),
  /** userConfig options whose value Next keeps as a secret and gives as the path of a 0600 file. */
  secretFiles: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodePluginJson = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudePluginJson));
const decodeWrappedMcp = Schema.decodeUnknownOption(Schema.fromJsonString(WrappedMcpJson));
const decodeBareMcp = Schema.decodeUnknownOption(Schema.fromJsonString(McpServers));
// Claude reads both the wrapped form and a bare map of servers.
const decodeMcpJson = (text: string) => {
  const wrapped = decodeWrappedMcp(text);
  return wrapped._tag === "Some" ? wrapped.value.mcpServers : Option.getOrNull(decodeBareMcp(text));
};
// A sidecar field the app does not know is refused: a newer one must not half-work here.
const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(Sidecar), {
  onExcessProperty: "error",
});

export interface PluginSetting {
  readonly name: string;
  readonly label: string;
  /** Kept in the secret store; a server gets the path of a 0600 file holding it, never the value. */
  readonly secret: boolean;
  readonly description?: string;
  readonly default?: string;
}

/** A plugin as the app runs it, whichever format its folder is in. */
export interface PluginDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** A Claude plugin folder: Claude loads it itself; other agents get its servers translated. */
  readonly claude: boolean;
  readonly hooks?: PluginManifest["hooks"];
  readonly setup?: PluginManifest["setup"];
  readonly settings: ReadonlyArray<PluginSetting>;
  readonly mcpServers: Readonly<Record<string, ClaudeMcpServer>>;
}

export type DefinitionParse =
  | { readonly _tag: "Valid"; readonly plugin: PluginDefinition }
  | { readonly _tag: "Invalid"; readonly reasons: ReadonlyArray<string> };

const ROOT = "${CLAUDE_PLUGIN_ROOT}";
const VARIABLE = /\$\{([^}]*)\}/g;
const USER_CONFIG = /^user_config\.(.+)$/;

const serverStrings = (server: ClaudeMcpServer): ReadonlyArray<string> =>
  "command" in server
    ? [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})]
    : [server.url, ...Object.values(server.headers ?? {})];

/** The userConfig options a server's strings name. */
export function serverSettings(server: ClaudeMcpServer): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const text of serverStrings(server)) {
    for (const match of text.matchAll(VARIABLE)) {
      const option = USER_CONFIG.exec(match[1] ?? "")?.[1];
      if (option !== undefined) names.add(option);
    }
  }
  return [...names];
}

/** A stdio server's command as a hook's is written: `./file` in the plugin, or a program name. */
export const pluginCommand = (command: string) =>
  command.startsWith(`${ROOT}/`) ? `./${command.slice(ROOT.length + 1)}` : command;

// A file of the plugin, or a program on PATH: never a path outside the plugin's folder.
const commandProblem = (command: string): string | null => {
  const relative = pluginCommand(command);
  if (relative.includes("${")) return `${command} may only start with ${ROOT}/.`;
  return resolveHookCommand("linux", "/plugin", [relative])._tag === "Unsafe"
    ? `${command} is not a file of the plugin or a program name.`
    : null;
};

/** A Claude plugin folder's files as one plugin, with every reason it is refused. */
export function parseClaudePlugin(files: {
  readonly plugin: string;
  readonly mcp?: string;
  readonly sidecar?: string;
}): DefinitionParse {
  const decoded = decodePluginJson(files.plugin);
  if (decoded._tag === "None") {
    return { _tag: "Invalid", reasons: [`${CLAUDE_PLUGIN_FILE} is not a plugin manifest.`] };
  }
  const json = decoded.value;
  const reasons: string[] = [];
  if (!validPluginId(json.name)) reasons.push(`name: ${json.name} is not a plugin id.`);
  if (json.version === undefined) reasons.push("version: a plugin installed here states one.");
  else if (!validPluginVersion(json.version)) {
    reasons.push(`version: ${json.version} is not a safe version name.`);
  }

  let sidecar: typeof Sidecar.Type = { schemaVersion: 2 };
  if (files.sidecar !== undefined) {
    const read = decodeSidecar(files.sidecar);
    if (read._tag === "None") reasons.push("agentd-plugin.json is not a version 2 sidecar.");
    else sidecar = read.value;
  }
  let servers: Readonly<Record<string, ClaudeMcpServer>> = {};
  if (files.mcp !== undefined) {
    const read = decodeMcpJson(files.mcp);
    if (read === null) reasons.push(`${CLAUDE_MCP_FILE} is not an MCP configuration.`);
    else servers = read;
  }

  const secretFiles = new Set(sidecar.secretFiles ?? []);
  const options = json.userConfig ?? {};
  for (const name of secretFiles) {
    if (!Object.hasOwn(options, name)) {
      reasons.push(`secretFiles: ${name} is not a userConfig option.`);
    }
  }
  const settings: PluginSetting[] = [];
  const sensitive = new Set<string>();
  for (const [name, option] of Object.entries(options)) {
    if (!SETTING_NAME.test(name)) {
      reasons.push(`userConfig: ${name} is not a setting name.`);
      continue;
    }
    if (option.sensitive === true) sensitive.add(name);
    const secret = secretFiles.has(name);
    if (secret && option.default !== undefined) {
      reasons.push(`userConfig: ${name} is a secret file and cannot have a default.`);
    }
    settings.push({
      name,
      label: option.title ?? name,
      secret,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.default === undefined || secret ? {} : { default: String(option.default) }),
    });
  }

  for (const [name, server] of Object.entries(servers)) {
    if (!MCP_SERVER_NAME.test(name)) reasons.push(`mcpServers: ${name} is not a server name.`);
    if ("command" in server) {
      const problem = commandProblem(server.command);
      if (problem !== null) reasons.push(`mcpServers.${name}.command: ${problem}`);
    }
    for (const option of serverSettings(server)) {
      if (!Object.hasOwn(options, option)) {
        reasons.push(`mcpServers.${name}: ${option} is not a userConfig option.`);
      } else if (sensitive.has(option)) {
        // Next cannot fill Claude's keychain, and the value would reach argv and protocol logs.
        reasons.push(
          `mcpServers.${name}: ${option} is sensitive; give it as a secret file (secretFiles in agentd-plugin.json).`,
        );
      }
    }
  }

  if (reasons.length > 0 || json.version === undefined) return { _tag: "Invalid", reasons };
  return {
    _tag: "Valid",
    plugin: {
      id: json.name,
      name: json.displayName ?? json.name,
      version: json.version,
      claude: true,
      ...(sidecar.hooks === undefined ? {} : { hooks: sidecar.hooks }),
      ...(sidecar.setup === undefined ? {} : { setup: sidecar.setup }),
      settings,
      mcpServers: servers,
    },
  };
}

/** A plugin folder in either format; a Claude plugin's `agentd-plugin.json` is its sidecar. */
export function parsePluginFiles(files: {
  readonly plugin: string | undefined;
  readonly mcp: string | undefined;
  readonly sidecar: string | undefined;
}): DefinitionParse {
  if (files.plugin !== undefined) {
    return parseClaudePlugin({
      plugin: files.plugin,
      ...(files.mcp === undefined ? {} : { mcp: files.mcp }),
      ...(files.sidecar === undefined ? {} : { sidecar: files.sidecar }),
    });
  }
  if (files.sidecar === undefined) {
    return {
      _tag: "Invalid",
      reasons: [`Neither ${CLAUDE_PLUGIN_FILE} nor ${PLUGIN_MANIFEST_FILE} can be read.`],
    };
  }
  const parsed = parsePluginManifest(files.sidecar);
  return parsed._tag === "Valid"
    ? { _tag: "Valid", plugin: definitionOfManifest(parsed.manifest) }
    : parsed;
}

/** A version 1 manifest as the same plugin: its settings become variables in the server's env. */
export function definitionOfManifest(manifest: PluginManifest): PluginDefinition {
  const mcpServers: Record<string, ClaudeMcpServer> = {};
  for (const [name, server] of Object.entries(manifest.contributes?.mcpServers ?? {})) {
    const env: Record<string, string> = { ...server.env };
    for (const [variable, reference] of Object.entries(server.settings ?? {})) {
      const setting = typeof reference === "string" ? reference : reference.setting;
      env[variable] = `\${user_config.${setting}}`;
    }
    const file = server.command.includes("/") || server.command.includes("\\");
    mcpServers[name] = {
      command: file ? `${ROOT}/${server.command.replace(/^\.\//, "")}` : server.command,
      args: server.args,
      env,
    };
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    claude: false,
    ...(manifest.hooks === undefined ? {} : { hooks: manifest.hooks }),
    ...(manifest.setup === undefined ? {} : { setup: manifest.setup }),
    settings: manifest.settings ?? [],
    mcpServers,
  };
}

export interface ExpandContext {
  /** The plugin's folder. */
  readonly root: string;
  /** The plugin's own data folder. */
  readonly data: string;
  /** A setting's value; for a secret one, the path of the file holding it. */
  readonly setting: (name: string) => string | undefined;
  /** The launching process's environment, for `${VAR}`. */
  readonly env: (name: string) => string | undefined;
}

export type ExpandedServer =
  | {
      readonly _tag: "Stdio";
      /** A file of the plugin, already resolved, or a program name for PATH. */
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly _tag: "Remote";
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** The server names its own OAuth client, which only Claude can use. */
      readonly oauthClient: boolean;
    }
  | { readonly _tag: "Missing"; readonly settings: ReadonlyArray<string> };

/**
 * A server with its variables filled in, as an agent other than Claude is given it. A setting
 * with no value leaves the server out, where Claude would start it with an empty string.
 */
export function expandMcpServer(server: ClaudeMcpServer, context: ExpandContext): ExpandedServer {
  const missing = new Set<string>();
  const expand = (text: string) =>
    text.replace(VARIABLE, (_whole, inner: string) => {
      if (inner === "CLAUDE_PLUGIN_ROOT") return context.root;
      if (inner === "CLAUDE_PLUGIN_DATA") return context.data;
      const option = USER_CONFIG.exec(inner)?.[1];
      if (option !== undefined) {
        const value = context.setting(option);
        if (value === undefined || value.length === 0) missing.add(option);
        return value ?? "";
      }
      const separator = inner.indexOf(":-");
      const name = separator === -1 ? inner : inner.slice(0, separator);
      const fallback = separator === -1 ? "" : inner.slice(separator + 2);
      return context.env(name) ?? fallback;
    });
  const record = (values: Readonly<Record<string, string>> | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, expand(value)]));
  const expanded: ExpandedServer =
    "command" in server
      ? {
          _tag: "Stdio",
          command: expand(server.command),
          args: (server.args ?? []).map(expand),
          env: record(server.env),
        }
      : {
          _tag: "Remote",
          transport: server.type,
          url: expand(server.url),
          headers: record(server.headers),
          oauthClient: server.oauth?.clientId !== undefined,
        };
  return missing.size === 0 ? expanded : { _tag: "Missing", settings: [...missing] };
}

const COMMIT = /^[0-9a-f]{40}$/;

const MarketplaceEntry = Schema.Struct({
  name: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Author),
  license: Schema.optionalKey(Schema.String),
  source: Schema.Unknown,
  /** What Next's catalogue adds to an entry; Claude warns about the key and ignores it. */
  libraos: Schema.optionalKey(
    Schema.Struct({
      reviewedAt: Schema.optionalKey(Schema.String),
      notices: Schema.optionalKey(Schema.Array(Schema.String)),
      renamedFrom: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Marketplace = Schema.Struct({
  name: Schema.String,
  plugins: Schema.Array(MarketplaceEntry),
});
const PinnedSource = Schema.Struct({
  source: Schema.Literal("git-subdir"),
  url: Schema.String,
  path: Schema.String,
  sha: Schema.String.check(Schema.isPattern(COMMIT)),
});
const decodeMarketplace = Schema.decodeUnknownOption(Schema.fromJsonString(Marketplace));
const decodePinned = Schema.decodeUnknownOption(PinnedSource);
// The catalogue's own checks: a safe id, version and folder path.
const decodeEntry = Schema.decodeUnknownOption(PluginCatalogEntry);

/**
 * A marketplace as a catalogue, or null when `text` is not one or repeats a name. Only an entry
 * pinned to a commit of a git folder is listed: Next installs nothing it cannot pin.
 */
export function parseMarketplace(text: string): PluginCatalog | null {
  const decoded = decodeMarketplace(text);
  if (decoded._tag === "None") return null;
  const names = decoded.value.plugins.map((plugin) => plugin.name);
  if (new Set(names).size !== names.length) return null;
  const plugins: PluginCatalogEntry[] = [];
  for (const entry of decoded.value.plugins) {
    const source = decodePinned(entry.source);
    if (source._tag === "None" || entry.version === undefined) continue;
    const listed = decodeEntry({
      id: entry.name,
      name: entry.displayName ?? entry.name,
      description: (entry.description ?? "").slice(0, 500),
      author: authorName(entry.author),
      licence: entry.license ?? "",
      reviewedAt: entry.libraos?.reviewedAt ?? "",
      version: entry.version,
      source: {
        url: source.value.url.replace(/\.git$/, ""),
        path: source.value.path,
        sha: source.value.sha,
        ...(entry.libraos?.notices === undefined ? {} : { notices: entry.libraos.notices }),
      },
      ...(entry.libraos?.renamedFrom === undefined
        ? {}
        : { renamedFrom: entry.libraos.renamedFrom }),
    });
    if (listed._tag === "Some" && validPluginVersion(entry.version)) plugins.push(listed.value);
  }
  return { version: 1, plugins };
}
