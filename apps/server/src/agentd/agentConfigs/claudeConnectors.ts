import {
  type AgentdConnector,
  type AgentdConnectorServer,
  AgentdCustomizeError,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../../processRunner.ts";
import { parseClaudeConfig } from "../claudeTrust.ts";
import { ConfigFileError, type ConfigFiles } from "./configFileWrite.ts";

// Claude Code's connectors as it reads them, from its files and never from `claude mcp list`,
// which starts every server. A switch is Claude's own per-project disabledMcpServers list; adding
// and removing go through its CLI.

/** One Claude Code instance, as its settings and environment place it. */
export interface ClaudeInstance {
  readonly binaryPath: string;
  /** CLAUDE_CONFIG_DIR, or ~/.claude. */
  readonly configDir: string;
  /** The global config holding user and local servers and the projects' switches. */
  readonly configFile: string;
  /** Where managed-mcp.json and managed-settings.json live on this host. */
  readonly managedDir: string | undefined;
  /** The whole env claude runs with, host session variables already left out. */
  readonly environment: NodeJS.ProcessEnv;
}

/** A project, with the key Claude Code files it under in its config. */
export interface ClaudeProject {
  readonly cwd: string;
  readonly key: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectOr = (value: unknown): Json => (isObject(value) ? value : {});
const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const keysOf = (value: unknown) => (isObject(value) ? Object.keys(value).toSorted() : []);
const byName = (servers: Json) =>
  Object.entries(servers).toSorted(([a], [b]) => a.localeCompare(b));
/** A `.mcp.json`'s servers, wrapped in `mcpServers` or not. */
const serversOf = (json: unknown): Json =>
  isObject(json) && isObject(json.mcpServers) ? json.mcpServers : isObject(json) ? json : {};

const isConfigFileError = Schema.is(ConfigFileError);
const parseLenient = Schema.decodeUnknownOption(fromLenientJson(Schema.Unknown));

type Place = Pick<AgentdConnector, "scope" | "enabled" | "toggle" | "removable"> & {
  readonly file: string;
  readonly plugin?: string;
};

/** A server entry of Claude's config as a row: the names of its env and headers, no values. */
function claudeConnector(name: string, raw: unknown, place: Place): AgentdConnector {
  const row = { name, envNames: [], headerNames: [], ...place };
  if (!isObject(raw)) {
    return { ...row, transport: "stdio", problem: "Claude Code can’t read this entry." };
  }
  if (raw.type === "http" || raw.type === "sse") {
    return {
      ...row,
      transport: raw.type,
      ...(typeof raw.url === "string" ? { url: raw.url } : { problem: "It has no URL." }),
      headerNames: keysOf(raw.headers),
    };
  }
  if (raw.type === undefined || raw.type === "stdio") {
    return {
      ...row,
      transport: "stdio",
      ...(typeof raw.command === "string"
        ? { command: raw.command }
        : { problem: "It has no command." }),
      args: stringsOf(raw.args),
      envNames: keysOf(raw.env),
    };
  }
  return {
    ...row,
    transport: "http",
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    problem: `This app can’t show a ${String(raw.type)} connector.`,
  };
}

/** The config text with name switched for the project and every other key as it was; null when it isn't a config. */
export function withServerEnabled(
  text: string | null,
  key: string,
  name: string,
  enabled: boolean,
): string | null {
  const config = parseClaudeConfig(text);
  if (!isObject(config)) return null;
  const projects = config.projects ?? {};
  if (!isObject(projects)) return null;
  const entry = projects[key] ?? {};
  if (!isObject(entry)) return null;
  const listed = entry.disabledMcpServers ?? [];
  if (!Array.isArray(listed)) return null;
  const others = listed.filter((other) => other !== name);
  const disabledMcpServers = enabled ? others : [...others, name];
  const next = { ...config, projects: { ...projects, [key]: { ...entry, disabledMcpServers } } };
  return JSON.stringify(next, null, 2) + (text?.endsWith("\n") ? "\n" : "");
}

/** An instance's rows, and why its config could not be read when it couldn't. */
export interface ClaudeListing {
  readonly connectors: ReadonlyArray<AgentdConnector>;
  readonly reason?: string;
}
const listing = (connectors: ReadonlyArray<AgentdConnector>, reason?: string): ClaudeListing =>
  reason === undefined ? { connectors } : { connectors, reason };

/** What `claude mcp add-json` reads for a server the person typed. */
const claudeServerJson = (server: AgentdConnectorServer) =>
  JSON.stringify(
    server.transport === "stdio"
      ? { type: "stdio", command: server.command, args: server.args, env: server.env }
      : { type: "http", url: server.url, headers: server.headers },
  );

const failed = (message: string) => new AgentdCustomizeError({ reason: "failed", message });

// Claude Code may save its config at any moment; a switch made from an older text is redone.
const WRITE_ATTEMPTS = 3;

export const makeClaudeConnectors = (deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly files: ConfigFiles;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
}) => {
  const { fs, path, files, runner } = deps;

  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrNull(parseLenient(text))),
      Effect.orElseSucceed(() => null),
    );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  /** Claude's settings files, lowest precedence first, as parsed objects. */
  const settingsLayers = Effect.fnUntraced(function* (
    instance: ClaudeInstance,
    project: ClaudeProject | null,
  ) {
    const names = [
      path.join(instance.configDir, "settings.json"),
      ...(project === null
        ? []
        : [
            path.join(project.cwd, ".claude", "settings.json"),
            path.join(project.cwd, ".claude", "settings.local.json"),
          ]),
      ...(instance.managedDir === undefined
        ? []
        : [path.join(instance.managedDir, "managed-settings.json")]),
    ];
    const layers: Array<Json> = [];
    for (const name of names) {
      const json = yield* readJson(name);
      if (isObject(json)) layers.push(json);
    }
    return layers;
  });

  const samePath = (a: string, b: string) =>
    path.resolve(a).replace(/\\/g, "/") === path.resolve(b).replace(/\\/g, "/");

  /** Servers of the plugins Claude installed and has turned on, named as Claude names them. */
  const pluginRows = Effect.fnUntraced(function* (
    instance: ClaudeInstance,
    project: ClaudeProject | null,
    layers: ReadonlyArray<Json>,
    place: (name: string) => Omit<Place, "file" | "scope">,
  ) {
    const enabled = new Map<string, boolean>();
    for (const layer of layers) {
      for (const [key, value] of Object.entries(objectOr(layer.enabledPlugins))) {
        if (typeof value === "boolean") enabled.set(key, value);
        else enabled.delete(key);
      }
    }
    const cache = instance.environment.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
    const pluginsDir = cache ? path.resolve(cache) : path.join(instance.configDir, "plugins");
    const installed = yield* readJson(path.join(pluginsDir, "installed_plugins.json"));
    const records = isObject(installed) ? objectOr(installed.plugins) : {};
    const rows: Array<AgentdConnector> = [];
    for (const [key, list] of byName(records)) {
      if (enabled.get(key) !== true || !Array.isArray(list)) continue;
      let install: string | undefined;
      for (const record of list) {
        if (!isObject(record) || typeof record.installPath !== "string") continue;
        const applies =
          record.scope === "user" ||
          record.scope === "managed" ||
          (project !== null &&
            typeof record.projectPath === "string" &&
            (samePath(record.projectPath, project.cwd) ||
              samePath(record.projectPath, project.key)));
        if (applies && (yield* exists(record.installPath))) {
          install = path.resolve(record.installPath);
          break;
        }
      }
      if (install === undefined) continue;
      const manifestFile = path.join(install, ".claude-plugin", "plugin.json");
      const manifest = yield* readJson(manifestFile);
      const plugin =
        isObject(manifest) && typeof manifest.name === "string" && manifest.name !== ""
          ? manifest.name
          : key.slice(0, key.lastIndexOf("@")) || key;
      const declared = isObject(manifest) ? manifest.mcpServers : undefined;
      const file = isObject(declared)
        ? manifestFile
        : typeof declared === "string"
          ? path.resolve(install, declared)
          : path.join(install, ".mcp.json");
      const servers = isObject(declared) ? declared : serversOf(yield* readJson(file));
      for (const [server, raw] of byName(servers)) {
        const name = `plugin:${plugin}:${server}`;
        rows.push(claudeConnector(name, raw, { ...place(name), scope: "plugin", file, plugin }));
      }
    }
    return rows;
  });

  const list = Effect.fn("ClaudeConnectors.list")(function* (
    instance: ClaudeInstance,
    project: ClaudeProject | null,
  ) {
    const text = yield* files.read(instance.configFile).pipe(Effect.orElseSucceed(() => null));
    const config = parseClaudeConfig(text);
    if (!isObject(config)) {
      return listing([], `Claude Code’s settings file ${instance.configFile} isn’t valid JSON.`);
    }
    const projects = isObject(config.projects) ? config.projects : {};
    const entry = project === null ? {} : objectOr(projects[project.key]);
    const disabled = new Set(stringsOf(entry.disabledMcpServers));
    const switchable = (name: string) => ({
      enabled: project === null || !disabled.has(name),
      toggle: "project" as const,
      removable: false,
    });
    const layers = yield* settingsLayers(instance, project);

    const user = byName(objectOr(config.mcpServers)).map(([name, raw]) =>
      claudeConnector(name, raw, {
        ...switchable(name),
        removable: true,
        scope: "user",
        file: instance.configFile,
      }),
    );
    const local = byName(objectOr(entry.mcpServers)).map(([name, raw]) =>
      claudeConnector(name, raw, {
        ...switchable(name),
        removable: true,
        scope: "local",
        file: instance.configFile,
      }),
    );

    let shared: Array<AgentdConnector> = [];
    if (project !== null) {
      const file = path.join(project.cwd, ".mcp.json");
      const approvals = [...layers, entry];
      const all = approvals.some((layer) => layer.enableAllProjectMcpServers === true);
      const approved = new Set(
        approvals.flatMap((layer) => stringsOf(layer.enabledMcpjsonServers)),
      );
      const refused = new Set(
        approvals.flatMap((layer) => stringsOf(layer.disabledMcpjsonServers)),
      );
      shared = byName(serversOf(yield* readJson(file))).map(([name, raw]) => {
        const row = claudeConnector(name, raw, { ...switchable(name), scope: "project", file });
        if (row.problem !== undefined) return row;
        if (refused.has(name))
          return { ...row, problem: "Turned down in Claude Code for this project." };
        if (!all && !approved.has(name))
          return {
            ...row,
            problem: "Claude Code hasn’t been allowed to use it in this project yet.",
          };
        return row;
      });
    }

    const plugins = yield* pluginRows(instance, project, layers, switchable);

    let managed: Array<AgentdConnector> = [];
    if (instance.managedDir !== undefined) {
      const file = path.join(instance.managedDir, "managed-mcp.json");
      const json = yield* readJson(file);
      if (json !== null) {
        managed = byName(serversOf(json)).map(([name, raw]) =>
          claudeConnector(name, raw, {
            enabled: true,
            toggle: "none",
            removable: false,
            scope: "managed",
            file,
          }),
        );
      }
    }

    // Claude Code uses a local server over a project one over a user one of the same name.
    const shadow = (rows: ReadonlyArray<AgentdConnector>, over: ReadonlyArray<AgentdConnector>) => {
      const names = new Map(over.map((row) => [row.name, row.scope]));
      return rows.map((row) => {
        const by = names.get(row.name);
        return by === undefined || row.problem !== undefined
          ? row
          : { ...row, problem: `Claude Code uses the ${by} connector of the same name.` };
      });
    };
    const ownRows = [
      ...shadow(user, [...local, ...shared]),
      ...local,
      ...shadow(shared, local),
      ...plugins,
    ];
    // managed-mcp.json is all Claude Code loads while it exists.
    const connectors =
      managed.length === 0
        ? ownRows
        : [
            ...ownRows.map((row) => ({
              ...row,
              problem: "Not used: an administrator’s managed-mcp.json sets this machine’s servers.",
            })),
            ...managed,
          ];
    return listing(connectors);
  });

  /** Switches name for the project in Claude's own per-project list. */
  const setEnabled = Effect.fn("ClaudeConnectors.setEnabled")(function* (
    instance: ClaudeInstance,
    project: ClaudeProject,
    name: string,
    enabled: boolean,
  ) {
    const unwritable = (error: unknown) =>
      failed(
        isConfigFileError(error)
          ? error.message
          : `Claude Code’s settings file ${instance.configFile} couldn’t be written.`,
      );
    for (let attempt = 1; ; attempt++) {
      const text = yield* files.read(instance.configFile).pipe(Effect.mapError(unwritable));
      const next = withServerEnabled(text, project.key, name, enabled);
      if (next === null) {
        return yield* new AgentdCustomizeError({
          reason: "invalid",
          message: `Claude Code’s settings file ${instance.configFile} isn’t in the expected format.`,
        });
      }
      if (next === text) return;
      // The config keeps its mode and a rolling .bak; a new one is private.
      if (
        yield* files
          .writeIfUnchanged(instance.configFile, next, text)
          .pipe(Effect.mapError(unwritable))
      )
        return;
      if (attempt === WRITE_ATTEMPTS) {
        return yield* new AgentdCustomizeError({
          reason: "changed",
          message: "Claude Code kept changing its settings file. Try again.",
        });
      }
    }
  });

  /** Runs claude with values only on stdin; what it prints is passed on without them. */
  const runClaude = Effect.fnUntraced(function* (
    instance: ClaudeInstance,
    args: ReadonlyArray<string>,
    cwd: string | undefined,
    stdin: string | undefined,
    secrets: ReadonlyArray<string>,
  ) {
    const output = yield* runner
      .run({
        command: instance.binaryPath,
        args,
        cwd,
        env: instance.environment,
        stdin,
        timeout: Duration.seconds(30),
      })
      .pipe(Effect.mapError(() => failed("Claude Code couldn’t be started.")));
    if (output.code === 0) return;
    let said = (output.stderr.trim() || output.stdout.trim()).split("\n")[0]?.trim() ?? "";
    for (const secret of secrets) if (secret.length > 0) said = said.replaceAll(secret, "…");
    return yield* failed(said === "" ? `Claude Code stopped with code ${output.code}.` : said);
  });

  const add = Effect.fn("ClaudeConnectors.add")(function* (
    instance: ClaudeInstance,
    project: ClaudeProject | null,
    name: string,
    scope: "user" | "local",
    server: AgentdConnectorServer,
  ) {
    const secrets = Object.values(server.transport === "stdio" ? server.env : server.headers);
    yield* runClaude(
      instance,
      ["mcp", "add-json", name, "-", "--scope", scope],
      scope === "local" ? project?.cwd : undefined,
      claudeServerJson(server),
      secrets,
    );
  });

  const remove = Effect.fn("ClaudeConnectors.remove")(function* (
    instance: ClaudeInstance,
    project: ClaudeProject | null,
    name: string,
    scope: "user" | "local",
  ) {
    yield* runClaude(
      instance,
      ["mcp", "remove", name, "--scope", scope],
      scope === "local" ? project?.cwd : undefined,
      undefined,
      [],
    );
  });

  return { list, setEnabled, add, remove };
};

export type ClaudeConnectors = ReturnType<typeof makeClaudeConnectors>;
