import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AgentdCustomizeAgentConnectors,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentdConnectors from "./AgentdConnectors.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";

const SECRET = "sk-very-secret-value";
const projectId = ProjectId.make("project-1");
const claudeId = ProviderInstanceId.make("claude-test");
const codexId = ProviderInstanceId.make("codex-test");
const opencodeId = ProviderInstanceId.make("opencode-test");

const notFound = () =>
  Effect.succeed({
    stdout: "",
    stderr: "",
    code: ChildProcessSpawner.ExitCode(1),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

/** The service over temp homes: a Claude, a Codex whose binary is missing, and an OpenCode. */
const withService = <A, E>(
  use: (context: {
    readonly connectors: AgentdConnectors.AgentdConnectorsService["Service"];
    readonly configFile: string;
    readonly cwd: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const claudeHome = path.join(dir, "claude-home");
    const cwd = path.join(dir, "repo");
    yield* fs.makeDirectory(claudeHome);
    yield* fs.makeDirectory(cwd);
    const configFile = path.join(claudeHome, ".claude.json");
    yield* fs.writeFileString(
      configFile,
      JSON.stringify({
        mcpServers: { tools: { command: "t", env: { TOKEN: SECRET } } },
        projects: { [cwd]: { disabledMcpServers: [] } },
      }),
    );
    yield* fs.writeFileString(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "s" } } }),
    );
    const settings = ServerSettings.layerTest({
      providerInstances: {
        [claudeId]: { driver: "claudeAgent", enabled: true, config: { homePath: claudeHome } },
        [codexId]: {
          driver: "codex",
          enabled: true,
          config: {
            binaryPath: path.join(dir, "no-such-codex"),
            homePath: path.join(dir, "codex"),
          },
        },
        [opencodeId]: { driver: "opencode", enabled: true },
      },
    });
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ projectId, workspaceRoot: cwd } as ProjectStore.ProjectRow)
            : Option.none(),
        ),
    });
    const plugins = Layer.mock(AgentdPlugins.AgentdPluginsService)({
      connectors: () =>
        Effect.succeed([
          {
            plugin: "kit",
            name: "kit-search",
            server: { command: "search", env: { KEY: SECRET } },
            claudeOnly: false,
          },
          {
            plugin: "kit",
            name: "kit-sse",
            server: { type: "sse", url: "https://kit.example/sse" },
            claudeOnly: true,
          },
        ]),
    });
    // git: not a repository, so the project's own folder is Claude's key.
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, { run: notFound });
    const layer = AgentdConnectors.layer.pipe(
      Layer.provide(Layer.mergeAll(settings, projects, plugins, runner)),
    );
    // The default instances resolve their homes here too, never the real one.
    const inTempHome = Effect.provideService(HostProcess.HomeDirectory, dir);
    const connectors = yield* AgentdConnectors.AgentdConnectorsService.pipe(
      Effect.provide(layer),
      inTempHome,
    );
    return yield* use({ connectors, configFile, cwd, fs }).pipe(inTempHome);
  }).pipe(
    Effect.provideService(HostProcess.Environment, { PATH: "" }),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const ours = (agents: ReadonlyArray<AgentdCustomizeAgentConnectors>) =>
  [claudeId, codexId, opencodeId].map((id) => agents.find((agent) => agent.instanceId === id));

describe("AgentdConnectors", () => {
  it.effect(
    "lists each agent's rows with the plugin rows it receives, and why the rest have none",
    () =>
      withService(({ connectors }) =>
        Effect.gen(function* () {
          const { agents } = yield* connectors.list({ projectId });
          const [claude, codex, opencode] = ours(agents);
          expect(claude?.supported).toBe(true);
          expect(claude?.connectors.map((row) => [row.scope, row.name, row.toggle])).toEqual([
            ["user", "tools", "project"],
            ["project", "shared", "project"],
            ["agentdPlugin", "kit-search", "none"],
            ["agentdPlugin", "kit-sse", "none"],
          ]);
          expect(codex?.supported).toBe(true);
          expect(codex?.reason).toContain("Codex");
          expect(codex?.connectors.map((row) => row.name)).toEqual(["kit-search"]);
          expect(opencode).toMatchObject({ supported: false, connectors: [] });
          expect(opencode?.reason).toBeDefined();
          expect(JSON.stringify(agents)).not.toContain(SECRET);
        }),
      ),
  );

  it.effect("switches a Claude server for the project and returns the new list", () =>
    withService(({ connectors, configFile, cwd, fs }) =>
      Effect.gen(function* () {
        const { agents } = yield* connectors.setEnabled({
          instanceId: claudeId,
          name: "tools",
          scope: "user",
          projectId,
          enabled: false,
        });
        expect(ours(agents)[0]?.connectors[0]).toMatchObject({ name: "tools", enabled: false });
        const config = JSON.parse(yield* fs.readFileString(configFile));
        expect(config.projects[cwd].disabledMcpServers).toEqual(["tools"]);
      }),
    ),
  );

  it.effect("refuses what can't be done here, each with its reason", () =>
    withService(({ connectors }) =>
      Effect.gen(function* () {
        const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
          Effect.flip(effect).pipe(Effect.map((error) => error.reason));
        const ref = { instanceId: claudeId, name: "tools", scope: "user" as const };
        expect(yield* reasonOf(connectors.setEnabled({ ...ref, enabled: false }))).toBe("invalid");
        expect(
          yield* reasonOf(
            connectors.setEnabled({ ...ref, scope: "agentdPlugin", projectId, enabled: false }),
          ),
        ).toBe("locked");
        expect(
          yield* reasonOf(
            connectors.remove({ ...ref, name: "shared", scope: "project", projectId }),
          ),
        ).toBe("locked");
        expect(yield* reasonOf(connectors.remove({ ...ref, name: "nothing", projectId }))).toBe(
          "notFound",
        );
        expect(
          yield* reasonOf(connectors.remove({ ...ref, instanceId: opencodeId, projectId })),
        ).toBe("unsupported");
        expect(
          yield* reasonOf(
            connectors.add({
              instanceId: claudeId,
              name: "has.dot",
              scope: "user",
              server: { transport: "stdio", command: "x", args: [], env: {} },
            }),
          ),
        ).toBe("invalid");
        expect(
          yield* reasonOf(
            connectors.add({
              instanceId: codexId,
              name: "ok",
              scope: "local",
              projectId,
              server: { transport: "http", url: "https://x.example/mcp", headers: {} },
            }),
          ),
        ).toBe("unsupported");
        expect(
          yield* reasonOf(connectors.list({ projectId: ProjectId.make("project-unknown") })),
        ).toBe("invalid");
      }),
    ),
  );
});
