import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import type { ProviderInstance, ProviderSkillSwitch } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse } from "jsonc-parser";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AgentdCustomizeSkills from "./AgentdCustomizeSkills.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const OPENCODE = ProviderInstanceId.make("opencode");
const PROJECT = ProjectId.make("project-1");
const CHECKED_AT = "2026-11-27T00:00:00.000Z";

const instanceOf = (
  instanceId: ProviderInstanceId,
  skillSwitch: ProviderSkillSwitch | undefined,
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(instanceId);
  return {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: instanceId },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(skillSwitch === undefined ? {} : { skillSwitch }),
  };
};

const providerOf = (
  instanceId: ProviderInstanceId,
  skills: ReadonlyArray<ServerProviderSkill>,
  workspace?: { readonly cwd: string; readonly skills: ReadonlyArray<ServerProviderSkill> },
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: CHECKED_AT,
  version: null,
  models: [],
  slashCommands: [],
  skills,
  ...(workspace === undefined
    ? {}
    : {
        workspaceSnapshots: [
          {
            cwd: workspace.cwd,
            checkedAt: CHECKED_AT,
            slashCommands: [],
            skills: workspace.skills,
          },
        ],
      }),
});

const harness = (options: { readonly codexEffective?: boolean; readonly windows?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const base = config.baseDir;
    const claudeDir = path.join(base, "claude");
    const codexHome = path.join(base, "codex");
    const project = path.join(base, "project");
    const programData = path.join(base, "ProgramData");
    yield* fs.makeDirectory(path.join(project, ".git"), { recursive: true });
    const skillFile = (directory: string, body = "---\nname: x\n---\nDo the thing.\n") =>
      fs
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(path.join(directory, "SKILL.md"), body)),
          Effect.as(path.join(directory, "SKILL.md")),
        );
    const review = yield* skillFile(path.join(claudeDir, "skills", "review"), "Review body\n");
    const unlisted = yield* skillFile(path.join(claudeDir, "skills", "unlisted"));
    const big = yield* skillFile(
      path.join(claudeDir, "skills", "big"),
      `${"a".repeat(AgentdCustomizeSkills.BODY_LIMIT_BYTES - 1)}é and more`,
    );
    const lint = yield* skillFile(
      path.join(claudeDir, "plugins", "cache", "tools", "skills", "lint"),
    );
    const deploy = yield* skillFile(path.join(project, ".claude", "skills", "deploy"));
    const demo = yield* skillFile(path.join(codexHome, "skills", "demo"), "Codex demo\n");
    const pluginSkill = yield* skillFile(path.join(config.stateDir, "plugins", "p", "skills", "s"));
    const opencodeSkill = yield* skillFile(path.join(base, "opencode", "skills", "o"));

    const claudeSkills: ReadonlyArray<ServerProviderSkill> = [
      { name: "review", path: review, enabled: true, scope: "user" },
      { name: "big", path: big, enabled: true, scope: "user" },
      { name: "tools:lint", path: lint, enabled: true, scope: "user" },
    ];
    const providers: ReadonlyArray<ServerProvider> = [
      providerOf(CLAUDE, claudeSkills, {
        cwd: project,
        skills: [
          ...claudeSkills,
          { name: "deploy", path: deploy, enabled: false, scope: "project" },
        ],
      }),
      providerOf(CODEX, [
        { name: "demo", path: demo, enabled: true, scope: "user" },
        { name: "p:s", path: pluginSkill, enabled: true, scope: "user" },
      ]),
      providerOf(OPENCODE, [{ name: "o", path: opencodeSkill, enabled: true }]),
    ];
    const refreshes: Array<string> = [];
    const codexWrites: Array<{ readonly path: string; readonly enabled: boolean }> = [];
    const instances = [
      instanceOf(CLAUDE, {
        kind: "claudeSettings",
        configDir: claudeDir,
        environment: { ProgramData: programData },
      }),
      instanceOf(CODEX, {
        kind: "codexAppServer",
        configFile: path.join(codexHome, "config.toml"),
        write: (input) =>
          Effect.sync(() => {
            codexWrites.push(input);
            return options.codexEffective ?? input.enabled;
          }),
      }),
      instanceOf(OPENCODE, undefined),
    ];

    const service = yield* AgentdCustomizeSkills.AgentdCustomizeSkillsService.pipe(
      Effect.provide(
        AgentdCustomizeSkills.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed(providers),
                refreshInstance: (instanceId) =>
                  Effect.sync(() => {
                    refreshes.push(`instance ${instanceId}`);
                    return providers;
                  }),
                refreshWorkspaceSnapshot: (input) =>
                  Effect.sync(() => {
                    refreshes.push(
                      `workspace ${input.instanceId} ${input.cwd} fresh=${input.fresh}`,
                    );
                    return providers;
                  }),
              }),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: (instanceId) =>
                  Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
              }),
              Layer.mock(ProjectService.ProjectService)({
                getById: (projectId) =>
                  Effect.succeed(
                    projectId === PROJECT
                      ? Option.some({ id: PROJECT, workspaceRoot: project } as Project)
                      : Option.none(),
                  ),
                workspaceScanDirectory: (cwd) => Effect.succeed(cwd),
              }),
              Layer.succeed(HostProcess.Platform, options.windows === true ? "win32" : "linux"),
            ),
          ),
        ),
      ),
    );
    const readJson = (file: string) =>
      fs.readFileString(file).pipe(Effect.map((text) => ({ text, value: parse(text) })));
    // What Claude's own skill reader, which builds the provider's list, now reports.
    const claudeEnabled = (name: string, cwd?: string) =>
      discoverClaudeSkills({ homePath: claudeDir }, cwd, { ProgramData: programData }).pipe(
        Effect.map((skills) => skills.find((skill) => skill.name === name)?.enabled),
        Effect.provideService(HostProcess.HomeDirectory, base),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
    return {
      fs,
      path,
      service,
      claudeDir,
      codexHome,
      project,
      programData,
      skills: { review, unlisted, big, lint, deploy, demo, pluginSkill, opencodeSkill },
      refreshes,
      codexWrites,
      readJson,
      claudeEnabled,
    };
  });

const dependencies = ServerConfig.layerTest("/tmp", { prefix: "agentd-customize-skills-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads a listed skill with its switch, and refuses a path the list does not name", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    expect(yield* h.service.read({ instanceId: CLAUDE, path: h.skills.review })).toEqual({
      path: h.skills.review,
      body: "Review body\n",
      truncated: false,
      toggle: "user",
      settingsFile: h.path.join(h.claudeDir, "settings.json"),
    });
    expect(yield* h.service.read({ instanceId: CODEX, path: h.skills.demo })).toEqual({
      path: h.skills.demo,
      body: "Codex demo\n",
      truncated: false,
      toggle: "user",
      settingsFile: h.path.join(h.codexHome, "config.toml"),
    });

    const big = yield* h.service.read({ instanceId: CLAUDE, path: h.skills.big });
    expect(big.truncated).toBe(true);
    // The cut falls inside "é", which is left out rather than garbled.
    expect(big.body).toBe("a".repeat(AgentdCustomizeSkills.BODY_LIMIT_BYTES - 1));

    const plugin = { toggle: "none", lockedReason: "follows its plugin; turn the plugin off" };
    expect(yield* h.service.read({ instanceId: CLAUDE, path: h.skills.lint })).toMatchObject(
      plugin,
    );
    expect(yield* h.service.read({ instanceId: CODEX, path: h.skills.pluginSkill })).toMatchObject(
      plugin,
    );
    expect(
      yield* h.service.read({ instanceId: OPENCODE, path: h.skills.opencodeSkill }),
    ).toMatchObject({ toggle: "none" });

    const refused = yield* Effect.flip(
      h.service.read({ instanceId: CLAUDE, path: h.skills.unlisted }),
    );
    expect(refused.reason).toBe("notFound");
    // A project's list names its own skills; the machine list does not.
    expect(
      (yield* Effect.flip(h.service.read({ instanceId: CLAUDE, path: h.skills.deploy }))).reason,
    ).toBe("notFound");
    expect(
      (yield* h.service.read({ instanceId: CLAUDE, path: h.skills.deploy, projectId: PROJECT }))
        .toggle,
    ).toBe("user");
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "switches a Claude skill in the user settings, keeping the file's other keys and comments",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const settingsFile = h.path.join(h.claudeDir, "settings.json");
      yield* h.fs.writeFileString(
        settingsFile,
        '{\n  // my theme\n  "theme": "dark",\n  "skillOverrides": {\n    "other": "name-only",\n  },\n}\n',
      );

      const off = yield* h.service.setEnabled({
        instanceId: CLAUDE,
        path: h.skills.review,
        enabled: false,
      });
      expect(off).toMatchObject({ toggle: "user", settingsFile });
      const written = yield* h.readJson(settingsFile);
      expect(written.text).toContain("// my theme");
      expect(written.value).toEqual({
        theme: "dark",
        skillOverrides: { other: "name-only", review: "off" },
      });
      expect(h.refreshes).toEqual([`instance ${CLAUDE}`]);
      expect(yield* h.claudeEnabled("review")).toBe(false);

      yield* h.service.setEnabled({ instanceId: CLAUDE, path: h.skills.review, enabled: true });
      const restored = yield* h.readJson(settingsFile);
      expect(restored.text).toContain("// my theme");
      expect(restored.value).toEqual({ theme: "dark", skillOverrides: { other: "name-only" } });
      expect(h.refreshes).toHaveLength(2);
      expect(yield* h.claudeEnabled("review")).toBe(true);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("creates the user settings file when there is none", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.setEnabled({ instanceId: CLAUDE, path: h.skills.review, enabled: false });
    expect((yield* h.readJson(h.path.join(h.claudeDir, "settings.json"))).value).toEqual({
      skillOverrides: { review: "off" },
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "refuses a skillOverrides map Claude Code would ignore, a plugin's skill, and other agents",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const settingsFile = h.path.join(h.claudeDir, "settings.json");
      const invalid = '{ "skillOverrides": { "other": true } }\n';
      yield* h.fs.writeFileString(settingsFile, invalid);
      const refused = yield* Effect.flip(
        h.service.setEnabled({ instanceId: CLAUDE, path: h.skills.review, enabled: false }),
      );
      expect(refused.reason).toBe("invalid");
      expect(yield* h.fs.readFileString(settingsFile)).toBe(invalid);

      const plugin = yield* Effect.flip(
        h.service.setEnabled({ instanceId: CLAUDE, path: h.skills.lint, enabled: false }),
      );
      expect(plugin.reason).toBe("locked");
      const libraosPlugin = yield* Effect.flip(
        h.service.setEnabled({ instanceId: CODEX, path: h.skills.pluginSkill, enabled: false }),
      );
      expect(libraosPlugin.reason).toBe("locked");
      const other = yield* Effect.flip(
        h.service.setEnabled({
          instanceId: OPENCODE,
          path: h.skills.opencodeSkill,
          enabled: false,
        }),
      );
      expect(other.reason).toBe("unsupported");
      expect(h.codexWrites).toEqual([]);
      expect(h.refreshes).toEqual([]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("switches a skill a project's settings decide in its settings.local.json", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const shared = h.path.join(h.project, ".claude", "settings.json");
    const local = h.path.join(h.project, ".claude", "settings.local.json");
    const sharedText = '{ "skillOverrides": { "deploy": "off" } }\n';
    yield* h.fs.writeFileString(shared, sharedText);
    const ref = { instanceId: CLAUDE, path: h.skills.deploy, projectId: PROJECT };

    expect(yield* h.service.read(ref)).toMatchObject({ toggle: "project", settingsFile: local });
    expect(yield* h.claudeEnabled("deploy", h.project)).toBe(false);
    yield* h.service.setEnabled({ ...ref, enabled: true });
    expect(yield* h.claudeEnabled("deploy", h.project)).toBe(true);
    // The shared file turns it off below, so on has to be written, not only an entry removed.
    expect((yield* h.readJson(local)).value).toEqual({ skillOverrides: { deploy: "on" } });
    expect(yield* h.fs.readFileString(shared)).toBe(sharedText);
    expect(h.refreshes).toEqual([`workspace ${CLAUDE} ${h.project} fresh=true`]);

    yield* h.service.setEnabled({ ...ref, enabled: false });
    expect((yield* h.readJson(local)).value).toEqual({ skillOverrides: { deploy: "off" } });
    expect(yield* h.claudeEnabled("deploy", h.project)).toBe(false);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("leaves a skill managed settings decide locked", () =>
  Effect.gen(function* () {
    const h = yield* harness({ windows: true });
    const managed = h.path.join(h.programData, "ClaudeCode", "managed-settings.json");
    yield* h.fs.makeDirectory(h.path.dirname(managed), { recursive: true });
    yield* h.fs.writeFileString(managed, '{ "skillOverrides": { "review": "off" } }');
    const ref = { instanceId: CLAUDE, path: h.skills.review };
    expect(yield* h.service.read(ref)).toMatchObject({ toggle: "none", settingsFile: managed });
    expect((yield* Effect.flip(h.service.setEnabled({ ...ref, enabled: true }))).reason).toBe(
      "locked",
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect("switches a Codex skill through its app-server and refreshes the provider", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const detail = yield* h.service.setEnabled({
      instanceId: CODEX,
      path: h.skills.demo,
      enabled: false,
    });
    expect(detail).toMatchObject({ path: h.skills.demo, toggle: "user" });
    expect(h.codexWrites).toEqual([{ path: h.skills.demo, enabled: false }]);
    expect(h.refreshes).toEqual([`instance ${CODEX}`]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("reports a Codex skill another Codex setting keeps as it was", () =>
  Effect.gen(function* () {
    const h = yield* harness({ codexEffective: true });
    const refused = yield* Effect.flip(
      h.service.setEnabled({ instanceId: CODEX, path: h.skills.demo, enabled: false }),
    );
    expect(refused.reason).toBe("locked");
    expect(h.refreshes).toEqual([`instance ${CODEX}`]);
  }).pipe(Effect.provide(dependencies)),
);
