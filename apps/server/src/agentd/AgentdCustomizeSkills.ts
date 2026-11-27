import {
  AgentdCustomizeError,
  type AgentdCustomizeErrorReason,
  type AgentdSkillDetail,
  type AgentdSkillRef,
  type AgentdSkillSetEnabledInput,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import type { ProviderInstance, ProviderSkillSwitch } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  claudeManagedSettingsPaths,
  claudeSettingsPaths,
  findRepositoryRoot,
  SkillOverrideValue,
} from "../provider/Drivers/ClaudeSkills.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

// The Customize page's Skills pane. A skill is only ever one the agent's own list names, and its
// switch is the agent's own: Claude Code's skillOverrides, Codex's skills.config. The app keeps no
// copy; after a write the provider is scanned again and the list shows what the agent will do.

/** Reads a skill the provider listed and writes the agent's own switch for it. */
export class AgentdCustomizeSkillsService extends Context.Service<
  AgentdCustomizeSkillsService,
  {
    readonly read: (
      input: AgentdSkillRef,
    ) => Effect.Effect<AgentdSkillDetail, AgentdCustomizeError>;
    readonly setEnabled: (
      input: AgentdSkillSetEnabledInput,
    ) => Effect.Effect<AgentdSkillDetail, AgentdCustomizeError>;
  }
>()("t3/agentd/AgentdCustomizeSkills/AgentdCustomizeSkillsService") {}

export const BODY_LIMIT_BYTES = 64 * 1024;
const PLUGIN_LOCKED = "follows its plugin; turn the plugin off";
const MANAGED_LOCKED = "set by your organization's managed settings";
const NO_SWITCH = "this agent has no skill switch the app can change";

const customizeError = (reason: AgentdCustomizeErrorReason, message: string) =>
  new AgentdCustomizeError({ reason, message });

type ClaudeSwitch = Extract<ProviderSkillSwitch, { readonly kind: "claudeSettings" }>;
type SkillOverride = typeof SkillOverrideValue.Type;
type SwitchInfo = Pick<AgentdSkillDetail, "toggle" | "settingsFile" | "lockedReason">;

const decodeOverrides = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, SkillOverrideValue),
);

type SettingsState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly problem: string }
  | {
      readonly kind: "valid";
      readonly text: string;
      readonly overrides: Readonly<Record<string, SkillOverride>>;
    };

interface SettingsLayer {
  readonly file: string;
  readonly managed: boolean;
  readonly state: SettingsState;
}

/** As Claude Code reads it: JSON with comments, whose whole skillOverrides map counts or none of it. */
function parseClaudeSettings(text: string): SettingsState {
  if (text.trim() === "") return { kind: "valid", text, overrides: {} };
  const errors: Array<ParseError> = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", problem: "is not a JSON object" };
  }
  const overrides = (value as Record<string, unknown>).skillOverrides;
  if (overrides === undefined) return { kind: "valid", text, overrides: {} };
  const decoded = decodeOverrides(overrides);
  return Option.isSome(decoded)
    ? { kind: "valid", text, overrides: decoded.value }
    : {
        kind: "invalid",
        problem:
          "has a skillOverrides value Claude Code does not accept (on, name-only, user-invocable-only or off), so Claude Code ignores all of them",
      };
}

function formattingOf(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  const tabs = indent?.startsWith("\t") === true;
  return {
    insertSpaces: !tabs,
    tabSize: indent === undefined || tabs ? 2 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** Sets or removes one skillOverrides entry, keeping the rest of the file as written. */
function editSkillOverride(text: string, name: string, value: SkillOverride | undefined): string {
  const base = text.trim() === "" ? "" : text;
  const edits = modify(base, ["skillOverrides", name], value, {
    formattingOptions: formattingOf(base),
  });
  if (edits.length === 0) return text;
  const next = applyEdits(base, edits);
  return base === "" ? `${next}\n` : next;
}

const overrideEnabled = (value: SkillOverride) => value !== "off";

const lastOverride = (layers: ReadonlyArray<SettingsLayer>, name: string) => {
  let found: { readonly index: number; readonly value: SkillOverride } | undefined;
  layers.forEach((layer, index) => {
    const value = layer.state.kind === "valid" ? layer.state.overrides[name] : undefined;
    if (value !== undefined) found = { index, value };
  });
  return found;
};

function isInside(path: Path.Path, directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectService.ProjectService;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // LibraOS Next plugins are installed here; their skills follow the plugin's switch.
  const pluginsRoot = path.join(stateDir, "plugins");
  const writes = yield* Semaphore.make(1);
  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const projectCwd = Effect.fn("AgentdCustomizeSkills.projectCwd")(function* (
    projectId: ProjectId | undefined,
  ) {
    if (projectId === undefined) return undefined;
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(() => customizeError("failed", "The project could not be read.")));
    if (Option.isNone(project)) {
      return yield* customizeError("notFound", "That project does not exist.");
    }
    return project.value.workspaceRoot;
  });

  const listedSkills = (
    current: ReadonlyArray<ServerProvider>,
    instanceId: ProviderInstanceId,
    cwd: string | undefined,
  ) => {
    const provider = current.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) return undefined;
    return cwd === undefined
      ? provider.skills
      : provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills;
  };

  const resolve = Effect.fn("AgentdCustomizeSkills.resolve")(function* (input: AgentdSkillRef) {
    const instance = yield* instances.getInstance(input.instanceId);
    if (instance === undefined) {
      return yield* customizeError("notFound", "That agent does not exist.");
    }
    const cwd = yield* projectCwd(input.projectId);
    let skills = listedSkills(yield* providers.getProviders, input.instanceId, cwd);
    if (skills === undefined && cwd !== undefined) {
      skills = listedSkills(
        yield* providers.refreshWorkspaceSnapshot({
          instanceId: input.instanceId,
          cwd,
          scanCwd: yield* projects.workspaceScanDirectory(cwd),
        }),
        input.instanceId,
        cwd,
      );
    }
    const skill = skills?.find((candidate) => candidate.path === input.path);
    if (skill === undefined) {
      return yield* customizeError("notFound", "That skill is not in the agent's list of skills.");
    }
    return { instance, skill, cwd };
  });

  const readBody = Effect.fn("AgentdCustomizeSkills.readBody")(
    function* (file: string) {
      const handle = yield* fs.open(file, { flag: "r" });
      const chunks: Array<Uint8Array> = [];
      let size = 0;
      while (size <= BODY_LIMIT_BYTES) {
        const chunk = yield* handle.readAlloc(BODY_LIMIT_BYTES + 1 - size);
        if (Option.isNone(chunk) || chunk.value.byteLength === 0) break;
        chunks.push(chunk.value);
        size += chunk.value.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const truncated = size > BODY_LIMIT_BYTES;
      // Streaming leaves out a character the cut split, rather than ending on U+FFFD.
      const body = new TextDecoder().decode(
        truncated ? bytes.subarray(0, BODY_LIMIT_BYTES) : bytes,
        { stream: truncated },
      );
      return { body, truncated };
    },
    Effect.scoped,
    Effect.mapError((error) =>
      error.reason._tag === "NotFound"
        ? customizeError("notFound", "The skill's SKILL.md is gone.")
        : customizeError("failed", "The skill's SKILL.md could not be read."),
    ),
  );

  const readSettingsLayer = (file: string, managed: boolean) =>
    fs.readFileString(file).pipe(
      Effect.map(parseClaudeSettings),
      Effect.catch((error) =>
        Effect.succeed<SettingsState>(
          error.reason._tag === "NotFound"
            ? { kind: "missing" }
            : { kind: "invalid", problem: "could not be read" },
        ),
      ),
      Effect.map((state): SettingsLayer => ({ file, managed, state })),
    );

  /** Claude Code's settings files, lowest precedence first, as its skill list reads them. */
  const readClaudeLayers = Effect.fn("AgentdCustomizeSkills.readClaudeLayers")(function* (
    skillSwitch: ClaudeSwitch,
    cwd: string | undefined,
  ) {
    const repositoryRoot =
      cwd === undefined ? undefined : yield* withFiles(findRepositoryRoot(cwd));
    const managed = new Set(claudeManagedSettingsPaths(path, platform, skillSwitch.environment));
    const files = claudeSettingsPaths(
      path,
      skillSwitch.configDir,
      cwd,
      platform,
      skillSwitch.environment,
      repositoryRoot,
    );
    return yield* Effect.forEach(files, (file) => readSettingsLayer(file, managed.has(file)));
  });

  /**
   * The file whose skillOverrides entry decides the skill: the user's settings.json, unless a
   * project or managed file sets it. A project's is then switched in its settings.local.json,
   * for this person only; a managed one cannot be switched.
   */
  const planClaude = (
    skillSwitch: ClaudeSwitch,
    layers: ReadonlyArray<SettingsLayer>,
    name: string,
    cwd: string | undefined,
  ): SwitchInfo => {
    const userFile = path.join(skillSwitch.configDir, "settings.json");
    const deciding = lastOverride(layers, name);
    const decidingLayer = deciding === undefined ? undefined : layers[deciding.index];
    if (decidingLayer?.managed === true) {
      return { toggle: "none", settingsFile: decidingLayer.file, lockedReason: MANAGED_LOCKED };
    }
    if (decidingLayer !== undefined && decidingLayer.file !== userFile && cwd !== undefined) {
      const settingsFile =
        path.basename(decidingLayer.file) === "settings.local.json"
          ? decidingLayer.file
          : path.join(cwd, ".claude", "settings.local.json");
      return { toggle: "project", settingsFile };
    }
    return { toggle: "user", settingsFile: userFile };
  };

  const describe = Effect.fn("AgentdCustomizeSkills.describe")(function* (
    instance: ProviderInstance,
    skill: ServerProviderSkill,
    cwd: string | undefined,
  ) {
    if (isInside(path, pluginsRoot, skill.path)) {
      return { toggle: "none", lockedReason: PLUGIN_LOCKED } satisfies SwitchInfo;
    }
    const skillSwitch = instance.skillSwitch;
    if (skillSwitch === undefined) {
      return { toggle: "none", lockedReason: NO_SWITCH } satisfies SwitchInfo;
    }
    if (skillSwitch.kind === "codexAppServer") {
      return { toggle: "user", settingsFile: skillSwitch.configFile } satisfies SwitchInfo;
    }
    // Claude names a plugin's skills <plugin>:<skill> and applies no override to them.
    if (skill.name.includes(":")) {
      return { toggle: "none", lockedReason: PLUGIN_LOCKED } satisfies SwitchInfo;
    }
    return planClaude(skillSwitch, yield* readClaudeLayers(skillSwitch, cwd), skill.name, cwd);
  });

  const read = Effect.fn("AgentdCustomizeSkills.read")(function* (input: AgentdSkillRef) {
    const { instance, skill, cwd } = yield* resolve(input);
    const info = yield* describe(instance, skill, cwd);
    const { body, truncated } = yield* readBody(skill.path);
    return { path: skill.path, body, truncated, ...info } satisfies AgentdSkillDetail;
  });

  const writeClaude = Effect.fn("AgentdCustomizeSkills.writeClaude")(function* (
    skillSwitch: ClaudeSwitch,
    name: string,
    cwd: string | undefined,
    enabled: boolean,
  ) {
    const layers = yield* readClaudeLayers(skillSwitch, cwd);
    const { settingsFile } = planClaude(skillSwitch, layers, name, cwd);
    const targetIndex = layers.findIndex((layer) => layer.file === settingsFile);
    const target = layers[targetIndex];
    if (settingsFile === undefined || target === undefined) {
      return yield* customizeError("failed", "Claude Code's settings file could not be found.");
    }
    if (target.state.kind === "invalid") {
      return yield* customizeError("invalid", `${target.file} ${target.state.problem}.`);
    }
    const text = target.state.kind === "valid" ? target.state.text : "";
    const current = target.state.kind === "valid" ? target.state.overrides[name] : undefined;
    if (current !== undefined && overrideEnabled(current) === enabled) return;
    // Turning on removes the entry, unless a file below turns it off.
    const below = lastOverride(layers.slice(0, targetIndex), name);
    const next = enabled
      ? below !== undefined && !overrideEnabled(below.value)
        ? "on"
        : undefined
      : "off";
    const updated = editSkillOverride(text, name, next);
    if (updated === text) return;
    const onDisk = yield* fs
      .readFileString(settingsFile)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(customizeError("failed", `${settingsFile} could not be read.`)),
        ),
      );
    if (onDisk !== text) {
      return yield* customizeError(
        "changed",
        `${settingsFile} changed while it was being written.`,
      );
    }
    yield* withFiles(writeFileStringAtomically({ filePath: settingsFile, contents: updated })).pipe(
      Effect.mapError(() => customizeError("failed", `${settingsFile} could not be written.`)),
    );
  });

  const refresh = (instanceId: ProviderInstanceId, cwd: string | undefined) =>
    cwd === undefined
      ? providers.refreshInstance(instanceId)
      : projects
          .workspaceScanDirectory(cwd)
          .pipe(
            Effect.flatMap((scanCwd) =>
              providers.refreshWorkspaceSnapshot({ instanceId, cwd, scanCwd, fresh: true }),
            ),
          );

  const setEnabled = Effect.fn("AgentdCustomizeSkills.setEnabled")(function* (
    input: AgentdSkillSetEnabledInput,
  ) {
    const { instance, skill, cwd } = yield* resolve(input);
    const skillSwitch = instance.skillSwitch;
    if (skillSwitch === undefined) {
      return yield* customizeError("unsupported", "This agent's skills cannot be switched here.");
    }
    const info = yield* describe(instance, skill, cwd);
    if (info.toggle === "none") {
      const reason = info.lockedReason ?? MANAGED_LOCKED;
      return yield* customizeError("locked", `${reason[0]?.toUpperCase()}${reason.slice(1)}.`);
    }
    if (skillSwitch.kind === "codexAppServer") {
      const effective = yield* writes.withPermits(1)(
        skillSwitch
          .write({ path: skill.path, enabled: input.enabled })
          .pipe(Effect.mapError((error) => customizeError("failed", error.detail))),
      );
      yield* refresh(input.instanceId, cwd);
      if (effective !== input.enabled) {
        return yield* customizeError(
          "locked",
          `Codex keeps this skill ${effective ? "on" : "off"}: another of its settings decides it.`,
        );
      }
    } else {
      yield* writes.withPermits(1)(writeClaude(skillSwitch, skill.name, cwd, input.enabled));
      yield* refresh(input.instanceId, cwd);
    }
    return yield* read(input);
  });

  return AgentdCustomizeSkillsService.of({ read, setEnabled });
});

export const layer = Layer.effect(AgentdCustomizeSkillsService, make);
