// @effect-diagnostics nodeBuiltinImport:off - paths for another OS, and a file name's hash.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  ThreadId,
  type AgentdBeforeSendContent,
  type AgentdPlaceholderMap,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CatalogSource,
  githubRepository,
  resolveInside,
  safeRelativePath,
} from "./skillCatalog.ts";

// The plugin catalogue's pure parts: its format, a plugin's manifest, the enabled setting, and the
// before-send hook's protocol. A hook is a command run with one JSON object on stdin that prints
// one JSON object on stdout; anything else stops the send.

/** Where the official catalogue's files are read from. */
export const PLUGIN_CATALOG_BASE = "https://raw.githubusercontent.com/libraos/plugins/main";
/** The catalogue's source name in `plugins/cache/<source>/<plugin>/<version>/`. */
export const PLUGIN_SOURCE = "libraos";
export const PLUGIN_MANIFEST_FILE = "agentd-plugin.json";
/** Written by install beside the plugin's files: every file it wrote. */
export const PLUGIN_INSTALL_RECORD = ".agentd-plugin-install.json";

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
export const validPluginId = (id: string) => PLUGIN_ID.test(id);
export const validPluginVersion = (version: string) =>
  VERSION.test(version) && safeRelativePath(version) !== null;

/** The official catalogue's repository; it is always a source and cannot be removed. */
export const OFFICIAL_REPOSITORY = "libraos/plugins";

/**
 * Where a plugin came from. A GitHub source's repository is lower case, as GitHub ignores case.
 */
export type PluginOrigin =
  | { readonly kind: "official" }
  | { readonly kind: "github"; readonly repository: string }
  | { readonly kind: "local" };

// Keys are per source, so a catalogue cannot replace or shadow an official plugin. An official
// plugin's key is its bare id, as before sources existed, so installs from then keep their
// folder, settings and secrets. `~` is in no plugin id, owner or repository name, so a key is
// unambiguous and is one safe path segment on every OS.
const KEY_SEPARATOR = "~";

/** `gh~owner~repo`: a GitHub source's folder under `plugins/cache/` and its secret's name. */
export const sourceSegment = (repository: string) =>
  `gh${KEY_SEPARATOR}${repository.replace("/", KEY_SEPARATOR)}`;

/** The key a plugin is installed, turned on and configured under. */
export function pluginKey(origin: PluginOrigin, id: string): string {
  if (origin.kind === "official") return id;
  if (origin.kind === "local") return `local${KEY_SEPARATOR}${id}`;
  return `${sourceSegment(origin.repository)}${KEY_SEPARATOR}${id}`;
}

/** The origin and id in a key, or null when it is not one. */
export function parsePluginKey(
  key: string,
): { readonly origin: PluginOrigin; readonly id: string } | null {
  const parts = key.split(KEY_SEPARATOR);
  const id = parts.at(-1) ?? "";
  if (!validPluginId(id)) return null;
  if (parts.length === 1) return { origin: { kind: "official" }, id };
  if (parts.length === 2 && parts[0] === "local") return { origin: { kind: "local" }, id };
  if (parts.length === 4 && parts[0] === "gh") {
    const repository = sourceRepository(`${parts[1]}/${parts[2]}`);
    return repository === null || repository !== `${parts[1]}/${parts[2]}`
      ? null
      : { origin: { kind: "github", repository }, id };
  }
  return null;
}

const isOfficialKey = (key: string) => !key.includes(KEY_SEPARATOR);

/**
 * Official plugins first, then by key: another catalogue's hook never runs before an official one,
 * and its MCP server never takes an official server's name.
 */
export const sortPluginKeys = (keys: Iterable<string>): ReadonlyArray<string> =>
  [...keys].toSorted((a, b) =>
    isOfficialKey(a) === isOfficialKey(b)
      ? a < b
        ? -1
        : a > b
          ? 1
          : 0
      : isOfficialKey(a)
        ? -1
        : 1,
  );

/**
 * `owner/repo` in lower case for what a person types as a catalogue source (`owner/repo`,
 * `github.com/owner/repo` or its https URL), or null. A name ending in a dot is refused: Windows
 * cannot create its folder.
 */
export function sourceRepository(input: string): string | null {
  const trimmed = input
    .trim()
    .replace(/^https:\/\//, "")
    .replace(/^github\.com\//, "");
  const repository = githubRepository(`https://github.com/${trimmed}`);
  if (repository === null || repository.endsWith(".")) return null;
  return repository.toLowerCase();
}

/** What a pasted source names: a repository, and for a link into a folder, what follows `tree/`. */
export interface SourceLink {
  readonly repository: string;
  /** The branch, then the folder; the branch may hold slashes, so only the end is matched. */
  readonly tree?: string;
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * A source as typed or pasted: `owner/repo`, the repository's link, a link to a folder in it
 * (`github.com/OWNER/REPO/tree/BRANCH/PATH`) or to its catalog.json (on github.com or the raw
 * host). Anything else is null, and nothing here ever names a folder on this computer.
 */
export function parseSourceLink(input: string): SourceLink | null {
  const trimmed = input.trim();
  const plain = sourceRepository(trimmed);
  if (plain !== null) return { repository: plain };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }
  let segments: Array<string>;
  try {
    segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(decodeURIComponent);
  } catch {
    return null;
  }
  const [owner = "", name = "", ...rest] = segments;
  const repository = sourceRepository(`${owner}/${name}`);
  if (repository === null) return null;
  if (url.host === "raw.githubusercontent.com") {
    return rest.length >= 2 && rest.at(-1) === "catalog.json" ? { repository } : null;
  }
  if (!GITHUB_HOSTS.has(url.host)) return null;
  if (rest.length === 0) return { repository };
  if (rest[0] === "tree" && rest.length >= 2) {
    return rest.length === 2 ? { repository } : { repository, tree: rest.slice(1).join("/") };
  }
  if (rest[0] === "blob" && rest.length >= 3 && rest.at(-1) === "catalog.json") {
    return { repository };
  }
  return null;
}

export type LinkedPlugin =
  | { readonly _tag: "Found"; readonly id: string }
  | { readonly _tag: "Elsewhere"; readonly id: string; readonly repository: string }
  | { readonly _tag: "Missing" };

/** The catalogue's plugin whose folder a link's `tree` ends with, pinned in `repository`. */
export function linkedPlugin(
  catalog: PluginCatalog | undefined,
  repository: string,
  tree: string,
): LinkedPlugin {
  let elsewhere: LinkedPlugin = { _tag: "Missing" };
  for (const entry of catalog?.plugins ?? []) {
    if (!tree.endsWith(`/${entry.source.path}`)) continue;
    const pinned = githubRepository(entry.source.url)?.toLowerCase() ?? entry.source.url;
    if (pinned === repository) return { _tag: "Found", id: entry.id };
    elsewhere = { _tag: "Elsewhere", id: entry.id, repository: pinned };
  }
  return elsewhere;
}

/** The catalogue sources a person added, and developer mode's local folders. */
export const PluginSources = Schema.Struct({
  github: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      /** The person confirmed reading it with the server's GitHub connection; nothing of it is kept. */
      githubConnection: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  developerMode: Schema.Boolean,
  /** Local plugins by id; each is read from its folder every time, not copied. */
  local: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});
export type PluginSources = typeof PluginSources.Type;
const EMPTY_PLUGIN_SOURCES: PluginSources = { github: [], developerMode: false, local: [] };
const decodeSources = Schema.decodeUnknownOption(Schema.fromJsonString(PluginSources));
/** No file, or one that does not read: only the official catalogue, developer mode off. */
export const readPluginSources = (text: string): PluginSources =>
  Option.getOrElse(decodeSources(text), () => EMPTY_PLUGIN_SOURCES);

/** The secret store's name for a source's token; nothing else keeps it. */
export const sourceTokenName = (repository: string) =>
  `agentd-plugin-source.${sourceSegment(repository)}`;

export const GITHUB_API = "https://api.github.com";

/**
 * Where a source's catalog.json is read on its default branch. With a token it is the GitHub API,
 * the only host a token is sent to; without one, the raw host the official catalogue uses.
 */
export const sourceCatalogUrl = (repository: string, withToken: boolean, file = "catalog.json") =>
  withToken
    ? `${GITHUB_API}/repos/${repository}/contents/${file}`
    : `https://raw.githubusercontent.com/${repository}/HEAD/${file}`;

/** Whether a request to `url` may carry the token of `repository`: the API, for that repository. */
export function tokenAllowed(url: string, repository: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.host === "api.github.com" &&
    parsed.username === "" &&
    parsed.pathname.toLowerCase().startsWith(`/repos/${repository.toLowerCase()}/`)
  );
}

export const PluginCatalogEntry = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(PLUGIN_ID)),
  name: Schema.String,
  description: Schema.String.check(Schema.isMaxLength(500)),
  author: Schema.String,
  licence: Schema.String,
  reviewedAt: Schema.String,
  version: Schema.String.check(Schema.isPattern(VERSION)),
  source: CatalogSource,
});
export type PluginCatalogEntry = typeof PluginCatalogEntry.Type;

export const PluginCatalog = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(PluginCatalogEntry),
});
export type PluginCatalog = typeof PluginCatalog.Type;

const decodeCatalogJson = Schema.decodeUnknownOption(Schema.fromJsonString(PluginCatalog));

/** The catalogue in `text`, or null when it does not decode or repeats a plugin id. */
export function parsePluginCatalog(text: string): PluginCatalog | null {
  const decoded = decodeCatalogJson(text);
  if (decoded._tag === "None") return null;
  const ids = decoded.value.plugins.map((plugin) => plugin.id);
  return new Set(ids).size === ids.length ? decoded.value : null;
}

export const PluginCatalogCache = Schema.Struct({
  attemptedAt: Schema.String,
  fetchedAt: Schema.optionalKey(Schema.String),
  catalog: Schema.optionalKey(PluginCatalog),
});
export type PluginCatalogCache = typeof PluginCatalogCache.Type;
export const decodePluginCatalogCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(PluginCatalogCache),
);

export const HookCommand = Schema.Struct({
  /** argv; a first element with a slash is a file in the plugin's folder, else found on PATH. */
  command: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(60)),
  ),
  /** The hook reads files it is not shown as text from their local path and may replace them. */
  attachmentFiles: Schema.optionalKey(Schema.Boolean),
});
export type HookCommand = typeof HookCommand.Type;

/** Run once from Settings before the plugin can be turned on; it never sees a message. */
export const SetupCommand = Schema.Struct({
  /** argv, resolved as a hook's is. */
  command: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  /** One sentence: what it downloads and how much disk it needs. */
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type SetupCommand = typeof SetupCommand.Type;

const SETTING_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// No dots: Codex splits its config override keys on every dot.
const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A value the person gives in Settings, Plugins; a secret one is kept in the secret store. */
const PluginSettingDeclaration = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(SETTING_NAME)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  secret: Schema.Boolean,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** Refused on a secret setting: a secret has no value anyone can read in the manifest. */
  default: Schema.optionalKey(Schema.String),
});
export type PluginSettingDeclaration = typeof PluginSettingDeclaration.Type;

/** A setting given to a server as an env var: its value, or the path of a 0600 file holding it. */
const McpServerSetting = Schema.Union([
  Schema.String.check(Schema.isPattern(SETTING_NAME)),
  Schema.Struct({
    setting: Schema.String.check(Schema.isPattern(SETTING_NAME)),
    file: Schema.Literal(true),
  }),
]);
export type McpServerSetting = typeof McpServerSetting.Type;

/** A stdio MCP server given to the agents the app launches while the plugin is on. */
const McpServerDeclaration = Schema.Struct({
  /** A file in the plugin's folder (with a slash) or a program on PATH, as a hook's command. */
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  env: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isPattern(ENV_NAME)), Schema.String),
  ),
  /** Env var name to the setting it carries. */
  settings: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isPattern(ENV_NAME)), McpServerSetting),
  ),
});
export type McpServerDeclaration = typeof McpServerDeclaration.Type;

/** `agentd-plugin.json` at the top of a plugin's folder. */
export const PluginManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  hooks: Schema.optionalKey(Schema.Struct({ "before-send": Schema.optionalKey(HookCommand) })),
  setup: Schema.optionalKey(SetupCommand),
  settings: Schema.optionalKey(Schema.Array(PluginSettingDeclaration)),
  contributes: Schema.optionalKey(
    Schema.Struct({
      mcpServers: Schema.optionalKey(
        Schema.Record(Schema.String.check(Schema.isPattern(MCP_SERVER_NAME)), McpServerDeclaration),
      ),
    }),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

// A field the app does not know is refused: a newer manifest must not half-work here.
const decodeManifestJson = Schema.decodeUnknownResult(Schema.fromJsonString(PluginManifest), {
  onExcessProperty: "error",
  errors: "all",
});

const settingOf = (value: McpServerSetting) => (typeof value === "string" ? value : value.setting);

/** Checks the schema cannot express: names, setting references and secrets without defaults. */
function manifestProblems(manifest: PluginManifest): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!validPluginId(manifest.id)) problems.push(`id: ${manifest.id} is not a plugin id.`);
  if (!validPluginVersion(manifest.version)) {
    problems.push(`version: ${manifest.version} is not a safe version name.`);
  }
  const declared = new Map<string, PluginSettingDeclaration>();
  for (const setting of manifest.settings ?? []) {
    if (declared.has(setting.name)) problems.push(`settings: ${setting.name} is declared twice.`);
    declared.set(setting.name, setting);
    if (setting.secret && setting.default !== undefined) {
      problems.push(`settings: ${setting.name} is secret and cannot have a default.`);
    }
  }
  for (const [name, server] of Object.entries(manifest.contributes?.mcpServers ?? {})) {
    if (resolveHookCommand("linux", "/plugin", [server.command])._tag === "Unsafe") {
      problems.push(`contributes.mcpServers.${name}.command: ${server.command} is not safe.`);
    }
    for (const [env, value] of Object.entries(server.settings ?? {})) {
      const setting = declared.get(settingOf(value));
      if (setting === undefined) {
        problems.push(
          `contributes.mcpServers.${name}.settings.${env}: ${settingOf(value)} is not a declared setting.`,
        );
      } else if (setting.secret && typeof value === "string") {
        // As a file, the value stays out of every provider's argv, protocol log and config.
        problems.push(
          `contributes.mcpServers.${name}.settings.${env}: ${setting.name} is secret, so it is given as a file ({ "setting": "${setting.name}", "file": true }).`,
        );
      }
      if (server.env !== undefined && Object.hasOwn(server.env, env)) {
        problems.push(`contributes.mcpServers.${name}: ${env} is in both env and settings.`);
      }
    }
  }
  return problems;
}

export type ManifestParse =
  | { readonly _tag: "Valid"; readonly manifest: PluginManifest }
  | { readonly _tag: "Invalid"; readonly reasons: ReadonlyArray<string> };

/** The manifest in `text` with every reason it is refused; the app and the catalogue check share it. */
export function parsePluginManifest(text: string): ManifestParse {
  const decoded = decodeManifestJson(text);
  if (decoded._tag === "Failure") {
    const lines = decoded.failure.message.split("\n");
    const reasons: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim();
      const at = lines[index + 1]?.trim();
      if (at?.startsWith("at ")) {
        reasons.push(`${at.slice(3)}: ${line}`);
        index++;
      } else if (line.length > 0) reasons.push(line);
    }
    return { _tag: "Invalid", reasons };
  }
  const problems = manifestProblems(decoded.success);
  return problems.length === 0
    ? { _tag: "Valid", manifest: decoded.success }
    : { _tag: "Invalid", reasons: problems };
}

export const decodePluginManifest = (text: string): Option.Option<PluginManifest> => {
  const parsed = parsePluginManifest(text);
  return parsed._tag === "Valid" ? Option.some(parsed.manifest) : Option.none();
};

export const PluginInstallRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  version: Schema.String,
  repository: Schema.String,
  commit: Schema.String,
  path: Schema.String,
  installedAt: Schema.String,
  /** Every file this install wrote, relative to the version's folder, forward slashes. */
  files: Schema.Array(Schema.String),
});
export type PluginInstallRecord = typeof PluginInstallRecord.Type;
export const decodePluginInstallRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(PluginInstallRecord),
);

/** `<stateDir>/plugins/setup/<id>.json`: how the last setup of an installed version ended. */
export const PluginSetupRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  version: Schema.String,
  commit: Schema.String,
  status: Schema.Literals(["ready", "failed"]),
  finishedAt: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type PluginSetupRecord = typeof PluginSetupRecord.Type;
export const decodePluginSetupRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(PluginSetupRecord),
);

/** A record counts only for the install it was made for; a new version or commit sets up again. */
export const setupReady = (
  record: PluginSetupRecord | null,
  install: { readonly version: string; readonly commit: string },
) =>
  record !== null &&
  record.status === "ready" &&
  record.version === install.version &&
  record.commit === install.commit;

/** The last non-empty line of `text`, at most 300 characters, or null. */
export function lastLine(text: string): string | null {
  const lines = text.split(/\r?\n|\r/).map((line) => line.trim());
  const last = lines.findLast((line) => line.length > 0);
  return last === undefined ? null : last.slice(0, 300);
}

/** Which plugins are on: for the environment, and per project where it differs. */
export const PluginSettings = Schema.Struct({
  enabled: Schema.Record(Schema.String, Schema.Boolean),
  projects: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
  /** Each plugin's settings that are not secret; secret ones are in the secret store only. */
  values: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
});
export type PluginSettings = typeof PluginSettings.Type;
const EMPTY_PLUGIN_SETTINGS: PluginSettings = { enabled: {}, projects: {} };
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(PluginSettings));
/** An unreadable setting turns nothing on. */
export const readPluginSettings = (text: string): PluginSettings =>
  Option.getOrElse(decodeSettings(text), () => EMPTY_PLUGIN_SETTINGS);

export function pluginEnabled(settings: PluginSettings, id: string, projectId?: string): boolean {
  const override = projectId === undefined ? undefined : settings.projects[projectId]?.[id];
  return override ?? settings.enabled[id] === true;
}

export function withPluginEnabled(
  settings: PluginSettings,
  id: string,
  enabled: boolean | null,
  projectId?: string,
): PluginSettings {
  if (projectId === undefined) {
    const { [id]: _previous, ...rest } = settings.enabled;
    return { ...settings, enabled: enabled === true ? { ...rest, [id]: true } : rest };
  }
  const { [id]: _previous, ...rest } = settings.projects[projectId] ?? {};
  const project = enabled === null ? rest : { ...rest, [id]: enabled };
  const { [projectId]: _old, ...projects } = settings.projects;
  return {
    ...settings,
    projects: Object.keys(project).length === 0 ? projects : { ...projects, [projectId]: project },
  };
}

/** Drops a removed plugin from every setting, so installing it again starts off. */
export function withoutPlugin(settings: PluginSettings, id: string): PluginSettings {
  const { [id]: _environment, ...enabled } = settings.enabled;
  const projects: Record<string, Record<string, boolean>> = {};
  for (const [projectId, overrides] of Object.entries(settings.projects)) {
    const { [id]: _project, ...rest } = overrides;
    if (Object.keys(rest).length > 0) projects[projectId] = rest;
  }
  const { [id]: _values, ...values } = settings.values ?? {};
  return { enabled, projects, ...(Object.keys(values).length === 0 ? {} : { values }) };
}

/** The plugin's non-secret values with `changes` applied; null clears one. */
export function withPluginValues(
  settings: PluginSettings,
  id: string,
  changes: Readonly<Record<string, string | null>>,
): PluginSettings {
  const next: Record<string, string> = { ...settings.values?.[id] };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  const { [id]: _old, ...others } = settings.values ?? {};
  const values = Object.keys(next).length === 0 ? others : { ...others, [id]: next };
  const { values: _previous, ...rest } = settings;
  return Object.keys(values).length === 0 ? rest : { ...rest, values };
}

/** The secret store's name for a plugin's secret setting; ids and setting names hold no dot. */
export const pluginSecretName = (id: string, setting: string) => `agentd-plugin.${id}.${setting}`;

/** A server as a launch gets it: a program, its args and the env it adds. */
export interface PluginMcpLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type McpServerEnv =
  | { readonly _tag: "Ready"; readonly env: Readonly<Record<string, string>> }
  | { readonly _tag: "Missing"; readonly settings: ReadonlyArray<string> };

/**
 * A server's env: its literal values and its settings, each a value or, for a file setting, the
 * path `file` gives it. A setting with no value and no default leaves the server out.
 */
export function mcpServerEnv(
  server: McpServerDeclaration,
  declared: ReadonlyArray<PluginSettingDeclaration>,
  value: (setting: PluginSettingDeclaration) => string | undefined,
  file: (setting: string) => string,
): McpServerEnv {
  const env: Record<string, string> = { ...server.env };
  const missing: string[] = [];
  for (const [name, reference] of Object.entries(server.settings ?? {})) {
    const setting = declared.find((known) => known.name === settingOf(reference));
    const given = setting === undefined ? undefined : (value(setting) ?? setting.default);
    if (setting === undefined || given === undefined || given.length === 0) {
      missing.push(settingOf(reference));
      continue;
    }
    env[name] = typeof reference === "string" ? given : file(setting.name);
  }
  return missing.length === 0 ? { _tag: "Ready", env } : { _tag: "Missing", settings: missing };
}

export type ResolvedCommand =
  | { readonly _tag: "File"; readonly path: string; readonly args: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly name: string; readonly args: ReadonlyArray<string> }
  | { readonly _tag: "Unsafe" };

/** The hook's argv: a file inside the plugin's folder, or a program name looked up on PATH. */
export function resolveHookCommand(
  platform: NodeJS.Platform,
  folder: string,
  argv: ReadonlyArray<string>,
): ResolvedCommand {
  const [first = "", ...args] = argv;
  if (first.includes("/") || first.includes("\\")) {
    const path = resolveInside(platform, folder, first.replace(/^\.\//, ""));
    return path === null ? { _tag: "Unsafe" } : { _tag: "File", path, args };
  }
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return path.basename(first) === first && !first.startsWith("-") && first !== ".."
    ? { _tag: "Path", name: first, args }
    : { _tag: "Unsafe" };
}

export interface HookProgram {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
  /** Pass over WindowsApps matches: Windows ships python.exe and python3.exe there as Store stubs. */
  readonly skipWindowsApps: boolean;
}

/** The programs to look up on PATH for a hook's program name, in order. */
export function hookPrograms(
  platform: NodeJS.Platform,
  name: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<HookProgram> {
  if (platform !== "win32" || name.toLowerCase() !== "python3") {
    return [{ name, args, skipWindowsApps: false }];
  }
  // A python.org install puts py and python on PATH, but not python3.
  return [
    { name, args, skipWindowsApps: true },
    { name: "py", args: ["-3", ...args], skipWindowsApps: false },
    { name: "python", args, skipWindowsApps: true },
  ];
}

/**
 * On Windows a .py file of the plugin cannot be started itself (os error 193): Next starts it
 * through py -3, else python, from PATH. Null elsewhere and for any other file: started as is.
 */
export function scriptPrograms(
  platform: NodeJS.Platform,
  script: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<HookProgram> | null {
  if (platform !== "win32" || !/\.py$/i.test(script)) return null;
  return [
    { name: "py", args: ["-3", script, ...args], skipWindowsApps: false },
    { name: "python", args: [script, ...args], skipWindowsApps: true },
  ];
}

export function isWindowsAppsPath(file: string): boolean {
  return /[\\/]microsoft[\\/]windowsapps[\\/]/i.test(file);
}

const HookAttachmentOut = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  /** For a file the hook replaced with text: the text attachment's name. */
  name: Schema.optionalKey(Schema.String),
});
const HookOutput = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("pass") }),
  Schema.Struct({
    decision: Schema.Literal("rewrite"),
    message: Schema.Struct({
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(HookAttachmentOut)),
    }),
    /** The thread's map after this rewrite; a hook without map support leaves it out. */
    placeholders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }),
]);
const decodeHookOutput = Schema.decodeUnknownOption(Schema.fromJsonString(HookOutput));

export type HookDecision =
  | { readonly _tag: "Pass" }
  | {
      readonly _tag: "Rewrite";
      readonly content: AgentdBeforeSendContent;
      readonly placeholders: AgentdPlaceholderMap;
    }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Invalid" };

/**
 * A placeholder starts and ends with a mark that is not a letter, digit or space, such as
 * `[PERSON_1]`, so restoring it cannot touch ordinary words or a longer placeholder.
 */
const PLACEHOLDER = /^[^\p{L}\p{N}\s]\S{1,98}[^\p{L}\p{N}\s]$/u;
const PLACEHOLDER_VALUE_MAX = 10_000;
const PLACEHOLDERS_MAX = 10_000;

/**
 * The thread's map with a hook's returned one added: existing entries stay, a returned entry that
 * gives an existing placeholder another value or is malformed makes the whole answer invalid.
 */
export function mergePlaceholders(
  current: AgentdPlaceholderMap,
  returned: AgentdPlaceholderMap | undefined,
): AgentdPlaceholderMap | null {
  if (returned === undefined) return current;
  const merged: Record<string, string> = { ...current };
  for (const [placeholder, value] of Object.entries(returned)) {
    if (!PLACEHOLDER.test(placeholder) || value.length === 0) return null;
    if (value.length > PLACEHOLDER_VALUE_MAX) return null;
    const known = Object.hasOwn(current, placeholder) ? current[placeholder] : undefined;
    if (known !== undefined && known !== value) return null;
    merged[placeholder] = value;
  }
  return Object.keys(merged).length > PLACEHOLDERS_MAX ? null : merged;
}

/** The placeholders of `map` in `content`, in the order they first appear. */
export function placeholdersIn(
  content: AgentdBeforeSendContent,
  map: AgentdPlaceholderMap,
): ReadonlyArray<string> {
  const seen: string[] = [];
  for (const text of [content.text, ...content.attachments.map((attachment) => attachment.text)]) {
    const found = Object.keys(map)
      .map((placeholder) => [placeholder, text.indexOf(placeholder)] as const)
      .filter(([placeholder, at]) => at >= 0 && !seen.includes(placeholder))
      .toSorted((a, b) => a[1] - b[1]);
    seen.push(...found.map(([placeholder]) => placeholder));
  }
  return seen;
}

const ATTACHMENT_NAME_MAX = 255;

/** A replacement's name: the hook's, as one file name ending in .txt, else the original's + .txt. */
export function replacementName(requested: string | undefined, original: string): string {
  const base = (requested ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .at(-1)!
    .trim();
  const name = base.length > 0 && base !== "." && base !== ".." ? base : original;
  const stem = /\.txt$/i.test(name) ? name.slice(0, -4) : name;
  return `${stem.slice(0, ATTACHMENT_NAME_MAX - 4).trim() || "attachment"}.txt`;
}

/**
 * What a hook printed, against what it was given. A rewrite may change shown text, replace a
 * `replaceable` file with non-empty text (put after the shown attachments) and add to the map;
 * naming another attachment, changing a known placeholder or not being exactly one decision is
 * invalid. A rewrite to the same content is a pass.
 */
export function parseHookOutput(
  stdout: string,
  input: AgentdBeforeSendContent,
  map: AgentdPlaceholderMap = {},
  replaceable: ReadonlyArray<{ readonly id: string; readonly name: string }> = [],
): HookDecision {
  const decoded = decodeHookOutput(stdout.trim());
  if (decoded._tag === "None") return { _tag: "Invalid" };
  const output = decoded.value;
  if (output.decision === "pass") return { _tag: "Pass" };
  if (output.decision === "block") {
    const reason = output.reason.trim().slice(0, 500);
    return { _tag: "Block", reason };
  }
  const replaced = new Map<string, { readonly text: string; readonly name?: string }>();
  for (const attachment of output.message.attachments ?? []) {
    if (replaced.has(attachment.id)) return { _tag: "Invalid" };
    replaced.set(attachment.id, attachment);
  }
  for (const [id, attachment] of replaced) {
    if (input.attachments.some((known) => known.id === id)) continue;
    const file = replaceable.find((known) => known.id === id);
    if (file === undefined || attachment.text.length === 0) return { _tag: "Invalid" };
  }
  const content: AgentdBeforeSendContent = {
    text: output.message.text,
    attachments: [
      ...input.attachments.map((attachment) => ({
        ...attachment,
        text: replaced.get(attachment.id)?.text ?? attachment.text,
      })),
      ...replaceable.flatMap((file) => {
        const replacement = replaced.get(file.id);
        return replacement === undefined
          ? []
          : [
              {
                id: file.id,
                name: replacementName(replacement.name, file.name),
                text: replacement.text,
              },
            ];
      }),
    ],
  };
  if (sameContent(content, input)) return { _tag: "Pass" };
  const placeholders = mergePlaceholders(map, output.placeholders);
  return placeholders === null ? { _tag: "Invalid" } : { _tag: "Rewrite", content, placeholders };
}

export const sameContent = (left: AgentdBeforeSendContent, right: AgentdBeforeSendContent) =>
  left.text === right.text &&
  left.attachments.length === right.attachments.length &&
  left.attachments.every(
    (attachment, index) =>
      attachment.id === right.attachments[index]?.id &&
      attachment.text === right.attachments[index]?.text,
  );

/** A thread's placeholder map on disk, one file per thread named by its id's hash. */
export const PlaceholderFile = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  placeholders: Schema.Record(Schema.String, Schema.String),
});
export type PlaceholderFile = typeof PlaceholderFile.Type;
export const decodePlaceholderFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(PlaceholderFile),
);
export const placeholderFileName = (threadId: string) =>
  `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`;

/**
 * An attachment that goes with the message but is not shown as text. A hook that declares
 * `attachmentFiles` also gets its type, size and, when the file is on this computer, its path.
 */
export interface HookUnshownAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly path?: string;
}

/**
 * What a hook reads on stdin; `unshownAttachments` go with the message but are not shown as text,
 * and `placeholders` is the thread's map so far.
 */
export const hookInput = (input: {
  readonly content: AgentdBeforeSendContent;
  readonly unshown: ReadonlyArray<HookUnshownAttachment>;
  readonly projectId: string;
  readonly threadId: string;
  readonly source: string;
  readonly placeholders?: AgentdPlaceholderMap | undefined;
}) =>
  JSON.stringify({
    version: 1,
    event: "before-send",
    message: input.content,
    unshownAttachments: input.unshown,
    placeholders: input.placeholders ?? {},
    context: { projectId: input.projectId, threadId: input.threadId, source: input.source },
  });

/** Largest attachment a hook is shown; a bigger or binary one is passed through unseen. */
const TEXT_ATTACHMENT_MAX_BYTES = 1024 * 1024;

/** The bytes as text when they are UTF-8 without NUL, else null. */
export function attachmentText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > TEXT_ATTACHMENT_MAX_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}
