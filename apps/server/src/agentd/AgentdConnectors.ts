import {
  type AgentdConnector,
  type AgentdConnectorAddInput,
  type AgentdConnectorRef,
  type AgentdConnectors,
  type AgentdConnectorSetEnabledInput,
  type AgentdConnectorsListInput,
  type AgentdCustomizeAgentConnectors,
  AgentdCustomizeError,
  type AgentdCustomizeErrorReason,
  ClaudeSettings,
  CodexSettings,
  type ProjectId,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type ClaudeInstance,
  type ClaudeProject,
  makeClaudeConnectors,
} from "./agentConfigs/claudeConnectors.ts";
import { type CodexConfigApi, makeCodexConnectors } from "./agentConfigs/codexConnectors.ts";
import { makeConfigFiles } from "./agentConfigs/configFileWrite.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";
import { projectFolder, resolveClaudeConfigFile, trustKey } from "./claudeTrust.ts";

/** The agents' own connectors (MCP servers), read from and written to each agent's configuration. */
export class AgentdConnectorsService extends Context.Service<
  AgentdConnectorsService,
  {
    readonly list: (
      input: AgentdConnectorsListInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly setEnabled: (
      input: AgentdConnectorSetEnabledInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly add: (
      input: AgentdConnectorAddInput,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
    readonly remove: (
      input: AgentdConnectorRef,
    ) => Effect.Effect<AgentdConnectors, AgentdCustomizeError>;
  }
>()("t3/agentd/AgentdConnectors/AgentdConnectorsService") {}

interface CodexInstance {
  readonly binaryPath: string;
  /** The person's own CODEX_HOME, also behind a shadow home, so writes reach their config.toml. */
  readonly homePath: string;
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
}

type Instance =
  | { readonly kind: "claude"; readonly id: ProviderInstanceId; readonly claude: ClaudeInstance }
  | { readonly kind: "codex"; readonly id: ProviderInstanceId; readonly codex: CodexInstance }
  | { readonly kind: "other"; readonly id: ProviderInstanceId; readonly driver: string };

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

// Claude and Codex accept other names, but these survive both CLIs, TOML keys and Codex's dotted paths.
const CONNECTOR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const refuse = (reason: AgentdCustomizeErrorReason, message: string) =>
  new AgentdCustomizeError({ reason, message });

/** A Next plugin's server as a row of an agent that receives it; the Plugins pane changes it. */
const pluginRow = (connector: AgentdPlugins.PluginConnector): AgentdConnector => {
  const { server } = connector;
  return {
    name: connector.name,
    ...("command" in server
      ? {
          transport: "stdio" as const,
          command: server.command,
          args: server.args ?? [],
          envNames: Object.keys(server.env ?? {}).toSorted(),
          headerNames: [],
        }
      : {
          transport: server.type,
          url: server.url,
          envNames: [],
          headerNames: Object.keys(server.headers ?? {}).toSorted(),
        }),
    scope: "agentdPlugin",
    plugin: connector.plugin,
    enabled: true,
    toggle: "none",
    removable: false,
  };
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const plugins = yield* AgentdPlugins.AgentdPluginsService;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const files = makeConfigFiles({ fs, path, platform });
  const claude = makeClaudeConnectors({ fs, path, files, runner });
  const codex = makeCodexConnectors(path);
  const managedDir =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? hostEnvironment.ProgramFiles && path.join(hostEnvironment.ProgramFiles, "ClaudeCode")
        : "/etc/claude-code";

  const claudeInstance = Effect.fnUntraced(function* (
    config: ClaudeSettings,
    environment: Parameters<typeof mergeProviderInstanceEnvironment>[0],
  ) {
    const merged = yield* mergeClaudeProcessEnvironment(config, environment, hostEnvironment);
    const claudeEnvironment = yield* makeClaudeEnvironment(config, merged);
    // The runner adds the host env back under the given one; keys left out stay unset.
    const unset = Object.fromEntries(Object.keys(hostEnvironment).map((key) => [key, undefined]));
    return {
      binaryPath: expandHomePath(config.binaryPath, home),
      configDir: yield* resolveClaudeHomePath(config, claudeEnvironment),
      configFile: yield* resolveClaudeConfigFile(fs, path, claudeEnvironment, home),
      managedDir,
      environment: { ...unset, ...claudeEnvironment },
    } satisfies ClaudeInstance;
  });

  const codexInstance = Effect.fnUntraced(function* (
    config: CodexSettings,
    environment: Parameters<typeof mergeProviderInstanceEnvironment>[0],
  ) {
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      hostEnvironment,
    );
    const environmentHome = processEnvironment.CODEX_HOME?.trim();
    const layout = yield* resolveCodexHomeLayout(
      !config.homePath.trim() && environmentHome
        ? { ...config, homePath: environmentHome }
        : config,
    );
    return {
      binaryPath: expandHomePath(config.binaryPath, home),
      homePath: layout.sharedHomePath,
      launchArgs: resolveCodexLaunchArgs(config.launchArgs, processEnvironment),
      environment: processEnvironment,
    } satisfies CodexInstance;
  });

  const instances = Effect.fnUntraced(
    function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => refuse("failed", "The app’s settings couldn’t be read.")),
      );
      const resolved: Array<Instance> = [];
      for (const [rawId, entry] of Object.entries(deriveProviderInstanceConfigMap(settings))) {
        const id = rawId as ProviderInstanceId;
        if (!resolveProviderInstanceEnabled(entry)) continue;
        if (entry.driver === "claudeAgent") {
          const config = decodeClaudeSettings(entry.config ?? {});
          if (Option.isSome(config)) {
            resolved.push({
              kind: "claude",
              id,
              claude: yield* claudeInstance(config.value, entry.environment),
            });
            continue;
          }
        } else if (entry.driver === "codex") {
          const config = decodeCodexSettings(entry.config ?? {});
          if (Option.isSome(config)) {
            resolved.push({
              kind: "codex",
              id,
              codex: yield* codexInstance(config.value, entry.environment),
            });
            continue;
          }
        }
        resolved.push({ kind: "other", id, driver: entry.driver });
      }
      return resolved;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const instanceOf = Effect.fnUntraced(function* (id: ProviderInstanceId) {
    const found = (yield* instances()).find((instance) => instance.id === id);
    if (found === undefined) return yield* refuse("notFound", "That agent isn’t set up here.");
    return found;
  });

  /** The project's folder, and the key Claude Code files it under: a worktree's main checkout. */
  const projectOf = Effect.fnUntraced(function* (projectId: ProjectId | undefined) {
    if (projectId === undefined) return null;
    const row = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => refuse("failed", "The project couldn’t be read.")));
    if (Option.isNone(row)) return yield* refuse("invalid", "That project isn’t open in the app.");
    const cwd = row.value.workspaceRoot;
    const commonDir = yield* runner
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
        timeout: Duration.seconds(10),
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
    return {
      cwd,
      key: trustKey(projectFolder(cwd, commonDir, path), path),
    } satisfies ClaudeProject;
  });

  /** Runs `use` with Codex's app-server for the instance, started in the project or home. */
  const withCodex = Effect.fn("AgentdConnectors.withCodex")(
    function* <A>(
      instance: CodexInstance,
      project: ClaudeProject | null,
      use: (api: CodexConfigApi) => Effect.Effect<A, AgentdCustomizeError>,
    ) {
      const { client } = yield* withCodexAppServerClient({
        binaryPath: instance.binaryPath,
        homePath: instance.homePath,
        launchArgs: instance.launchArgs,
        cwd: project?.cwd ?? home,
        environment: instance.environment,
      }).pipe(
        Effect.mapError(() => refuse("failed", "Codex couldn’t be started to read its config.")),
      );
      return yield* use({
        read: (cwd) => client.request("config/read", { cwd, includeLayers: true }),
        write: (params) => client.request("config/batchWrite", params),
      });
    },
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.fail(refuse("failed", "Codex took too long to answer.")),
    }),
  );

  const listInstance = (
    instance: Instance,
    project: ClaudeProject | null,
    pluginConnectors: ReadonlyArray<AgentdPlugins.PluginConnector>,
  ): Effect.Effect<AgentdCustomizeAgentConnectors> => {
    const forAgent = (claudeOnlyToo: boolean) =>
      pluginConnectors.filter((connector) => claudeOnlyToo || !connector.claudeOnly).map(pluginRow);
    switch (instance.kind) {
      case "claude":
        return claude.list(instance.claude, project).pipe(
          Effect.map((listing) => ({
            instanceId: instance.id,
            supported: true,
            ...(listing.reason === undefined ? {} : { reason: listing.reason }),
            connectors: [...listing.connectors, ...forAgent(true)],
          })),
        );
      case "codex":
        return withCodex(instance.codex, project, (api) =>
          codex.list(api, project?.cwd ?? null),
        ).pipe(
          Effect.map((listing) => ({
            instanceId: instance.id,
            supported: true,
            connectors: [...listing.connectors, ...forAgent(false)],
          })),
          Effect.catch((error) =>
            Effect.succeed({
              instanceId: instance.id,
              supported: true,
              reason: error.message,
              connectors: forAgent(false),
            }),
          ),
        );
      case "other":
        return Effect.succeed({
          instanceId: instance.id,
          supported: false,
          reason: `This app can’t read or change ${instance.driver} connectors yet; only Claude Code’s and Codex’s.`,
          connectors: [],
        });
    }
  };

  const list = Effect.fn("AgentdConnectors.list")(function* (input: AgentdConnectorsListInput) {
    const project = yield* projectOf(input.projectId);
    const pluginConnectors =
      input.projectId === undefined ? [] : yield* plugins.connectors(input.projectId);
    const agents = yield* Effect.forEach(
      yield* instances(),
      (instance) => listInstance(instance, project, pluginConnectors),
      { concurrency: "unbounded" },
    );
    return { agents } satisfies AgentdConnectors;
  });

  const rowOf = (rows: ReadonlyArray<AgentdConnector>, ref: AgentdConnectorRef) => {
    const row = rows.find(
      (candidate) => candidate.name === ref.name && candidate.scope === ref.scope,
    );
    return row === undefined
      ? Effect.fail(refuse("notFound", `There’s no ${ref.scope} connector named ${ref.name}.`))
      : Effect.succeed(row);
  };
  const lockedUnless = (allowed: boolean, row: AgentdConnector, fallback: string) =>
    allowed ? Effect.void : Effect.fail(refuse("locked", row.problem ?? fallback));
  const notHere = (scope: AgentdConnectorRef["scope"]) =>
    scope === "agentdPlugin"
      ? Effect.fail(refuse("locked", "It comes with a plugin; change it on the Plugins pane."))
      : Effect.void;
  const unsupported = (instance: Instance) =>
    instance.kind === "other"
      ? Effect.fail(
          refuse("unsupported", `This app can’t change ${instance.driver} connectors yet.`),
        )
      : Effect.void;
  const needProject = <A>(project: A | null, message: string) =>
    project === null ? Effect.fail(refuse("invalid", message)) : Effect.succeed(project);

  const setEnabled = Effect.fn("AgentdConnectors.setEnabled")(function* (
    input: AgentdConnectorSetEnabledInput,
  ) {
    yield* notHere(input.scope);
    const instance = yield* instanceOf(input.instanceId);
    yield* unsupported(instance);
    const project = yield* projectOf(input.projectId);
    const cantSwitch = "It can’t be switched here.";
    if (instance.kind === "claude") {
      const chosen = yield* needProject(
        project,
        "Choose a project: Claude Code switches connectors per project.",
      );
      const row = yield* rowOf((yield* claude.list(instance.claude, chosen)).connectors, input);
      yield* lockedUnless(row.toggle !== "none", row, cantSwitch);
      yield* claude.setEnabled(instance.claude, chosen, input.name, input.enabled);
    } else if (instance.kind === "codex") {
      yield* withCodex(instance.codex, project, (api) =>
        Effect.gen(function* () {
          const listing = yield* codex.list(api, project?.cwd ?? null);
          const row = yield* rowOf(listing.connectors, input);
          yield* lockedUnless(row.toggle !== "none", row, cantSwitch);
          yield* codex.setEnabled(api, input.name, input.enabled, listing.userVersion);
        }),
      );
    }
    return yield* list(input.projectId === undefined ? {} : { projectId: input.projectId });
  });

  const add = Effect.fn("AgentdConnectors.add")(function* (input: AgentdConnectorAddInput) {
    if (!CONNECTOR_NAME.test(input.name)) {
      return yield* refuse(
        "invalid",
        "A connector’s name is up to 64 letters, digits, hyphens and underscores.",
      );
    }
    const { server } = input;
    if (server.transport === "stdio" && server.command.trim() === "") {
      return yield* refuse("invalid", "Enter the command that starts the server.");
    }
    if (server.transport === "http" && !/^https?:\/\/\S+$/i.test(server.url)) {
      return yield* refuse("invalid", "Enter the server’s http:// or https:// address.");
    }
    const instance = yield* instanceOf(input.instanceId);
    yield* unsupported(instance);
    const project = yield* projectOf(input.projectId);
    if (instance.kind === "claude") {
      if (input.scope === "local") yield* needProject(project, "Choose the project to add it to.");
      yield* claude.add(instance.claude, project, input.name, input.scope, server);
    } else if (instance.kind === "codex") {
      if (input.scope !== "user") {
        return yield* refuse(
          "unsupported",
          "Codex keeps a person’s connectors for every project; add it for all projects.",
        );
      }
      yield* withCodex(instance.codex, project, (api) =>
        Effect.gen(function* () {
          const listing = yield* codex.list(api, project?.cwd ?? null);
          // Codex merges tables of one name across its config files into a single server.
          if (listing.connectors.some((row) => row.name === input.name)) {
            return yield* refuse("invalid", `Codex already has a connector named ${input.name}.`);
          }
          yield* codex.add(api, input.name, server, listing.userVersion);
        }),
      );
    }
    return yield* list(input.projectId === undefined ? {} : { projectId: input.projectId });
  });

  const remove = Effect.fn("AgentdConnectors.remove")(function* (input: AgentdConnectorRef) {
    yield* notHere(input.scope);
    const instance = yield* instanceOf(input.instanceId);
    yield* unsupported(instance);
    const project = yield* projectOf(input.projectId);
    const notRemovable = "Only connectors added for you or for this project can be removed here.";
    if (instance.kind === "claude") {
      const row = yield* rowOf((yield* claude.list(instance.claude, project)).connectors, input);
      if (!row.removable || (row.scope !== "user" && row.scope !== "local")) {
        return yield* refuse("locked", notRemovable);
      }
      yield* claude.remove(instance.claude, project, input.name, row.scope);
    } else if (instance.kind === "codex") {
      yield* withCodex(instance.codex, project, (api) =>
        Effect.gen(function* () {
          const listing = yield* codex.list(api, project?.cwd ?? null);
          const row = yield* rowOf(listing.connectors, input);
          yield* lockedUnless(row.removable, row, notRemovable);
          yield* codex.remove(api, input.name, listing.userVersion);
        }),
      );
    }
    return yield* list(input.projectId === undefined ? {} : { projectId: input.projectId });
  });

  return AgentdConnectorsService.of({ list, setEnabled, add, remove });
});

export const layer = Layer.effect(AgentdConnectorsService, make);
