import {
  AgentdBeforeSendError,
  AgentdPluginError,
  type AgentdBeforeSendAttachment,
  type AgentdBeforeSendConfirmInput,
  type AgentdBeforeSendContent,
  type AgentdBeforeSendReview,
  type AgentdBeforeSendReviewInput,
  type AgentdPlaceholderMap,
  type AgentdPluginEnableInput,
  type AgentdPluginErrorReason,
  type AgentdPluginInput,
  type AgentdPlugins,
  type AgentdPluginsListInput,
  type ChatAttachment,
  type CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { planAttachmentClaim, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { downloadPinned, getUrlBytes } from "./AgentdSkills.ts";
import {
  PLUGIN_CATALOG_URL,
  PLUGIN_INSTALL_RECORD,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_SOURCE,
  PluginCatalogCache,
  PluginInstallRecord,
  PluginSettings,
  PlaceholderFile,
  type PluginCatalog,
  type PluginManifest,
  attachmentText,
  decodePlaceholderFile,
  decodePluginCatalogCache,
  decodePluginInstallRecord,
  decodePluginManifest,
  hookInput,
  parseHookOutput,
  parsePluginCatalog,
  placeholderFileName,
  placeholdersIn,
  pluginEnabled,
  readPluginSettings,
  resolveHookCommand,
  sameContent,
  validPluginId,
  validPluginVersion,
  withPluginEnabled,
  withoutPlugin,
} from "./pluginCatalog.ts";
import {
  fetchDue,
  githubRepository,
  resolveInside,
  stagingSuffix,
  type HostPaths,
} from "./skillCatalog.ts";

// Enabled before-send hooks run in id order, each on the previous one's output; any block, failure
// or missing command stops the send. A reviewable rewrite is held until confirmed or closed.
// Message text never goes to logs or spans: hook stdout and stderr are read and dropped. Nor does a
// thread's placeholder map, kept in plugins/placeholders/ readable by this user alone.

/**
 * The commands whose hooks the intake ran, so the dispatch backstop does not run them again.
 * Only those ids: anything else dispatched inside the same call is still checked.
 */
export const BeforeSendChecked = Context.Reference<ReadonlySet<CommandId>>(
  "t3/agentd/AgentdPlugins/BeforeSendChecked",
  { defaultValue: () => new Set() },
);

/** How to send a held message again once the person confirms it. */
export type BeforeSendResend =
  | { readonly kind: "dispatch"; readonly command: OrchestrationV2Command }
  | { readonly kind: "launch"; readonly input: ThreadLaunchInput };

export interface BeforeSendRequest {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Where the send came from, for the hook (web, mobile, mcp, server). */
  readonly source: string;
  /** Present when a person can review a rewrite; without it a rewrite stops the send. */
  readonly resend?: BeforeSendResend | undefined;
}

export class AgentdPluginsService extends Context.Service<
  AgentdPluginsService,
  {
    readonly list: (
      input: AgentdPluginsListInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    readonly install: (input: AgentdPluginInput) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    readonly remove: (input: AgentdPluginInput) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    readonly setEnabled: (
      input: AgentdPluginEnableInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /** Whether a send in the project runs any hook; reads no hook command. */
    readonly hasBeforeSend: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** Runs the project's hooks; succeeds only when the message may go as it is. */
    readonly checkBeforeSend: (
      request: BeforeSendRequest,
    ) => Effect.Effect<void, AgentdBeforeSendError>;
    readonly review: (
      input: AgentdBeforeSendReviewInput,
    ) => Effect.Effect<AgentdBeforeSendReview | null>;
    /** The held send with the confirmed content in it; the review is gone after. */
    readonly confirm: (
      input: AgentdBeforeSendConfirmInput,
    ) => Effect.Effect<BeforeSendResend, AgentdBeforeSendError>;
    readonly discard: (reviewId: string) => Effect.Effect<void>;
    /** The thread's placeholders and the originals they stand for; empty when it has none. */
    readonly placeholders: (threadId: ThreadId) => Effect.Effect<AgentdPlaceholderMap>;
    /** Deletes the thread's placeholder map, as when the thread is deleted. */
    readonly forgetPlaceholders: (threadId: ThreadId) => Effect.Effect<void>;
    /** Every thread with a placeholder map. */
    readonly placeholderThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
  }
>()("t3/agentd/AgentdPlugins/AgentdPluginsService") {}

const REVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;
const HOOK_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PLUGIN_LAYOUT = { required: PLUGIN_MANIFEST_FILE, manifest: PLUGIN_INSTALL_RECORD };

const fail = (reason: AgentdPluginErrorReason, message: string) =>
  Effect.fail(new AgentdPluginError({ reason, message }));
const blocked = (message: string) => new AgentdBeforeSendError({ reason: "blocked", message });

const encodeCache = Schema.encodeSync(Schema.fromJsonString(PluginCatalogCache));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(PluginInstallRecord));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(PluginSettings));
const encodePlaceholderFile = Schema.encodeSync(Schema.fromJsonString(PlaceholderFile));
const isPluginError = Schema.is(AgentdPluginError);

interface Installed {
  readonly folder: string;
  readonly record: PluginInstallRecord;
  readonly manifest: PluginManifest | null;
}

interface Hook {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly manifest: PluginManifest | null;
}

interface HeldReview {
  readonly review: AgentdBeforeSendReview;
  /** The thread's map with this message's new placeholders; stored once the person confirms. */
  readonly placeholders: AgentdPlaceholderMap;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly resend: BeforeSendResend;
  readonly expiresAt: number;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host: HostPaths = {
    platform: yield* HostProcess.Platform,
    home: yield* HostProcess.HomeDirectory,
    env: yield* HostProcess.Environment,
  };
  const root = path.join(config.stateDir, "plugins");
  const cacheRoot = path.join(root, "cache", PLUGIN_SOURCE);
  const catalogFile = path.join(root, "catalog.json");
  const settingsFile = path.join(root, "settings.json");
  const lock = yield* Semaphore.make(1);
  const reviews = yield* Ref.make(new Map<string, HeldReview>());
  const placeholderRoot = path.join(root, "placeholders");
  const placeholderLock = yield* Semaphore.make(1);

  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const writeAtomic = (file: string, text: string) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(`${file}.tmp`, text)),
        Effect.andThen(fs.rename(`${file}.tmp`, file)),
      );

  // Read on every send: a setting written by another server process is seen at once.
  const readSettings = fs.readFileString(settingsFile).pipe(
    Effect.map(readPluginSettings),
    Effect.orElseSucceed(() => readPluginSettings("")),
  );

  const readCache = fs.readFileString(catalogFile).pipe(
    Effect.map((text) => Option.getOrNull(decodePluginCatalogCache(text))),
    Effect.orElseSucceed(() => null),
  );

  const catalog = Effect.fn("AgentdPlugins.catalog")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cache = yield* readCache;
    const cached = {
      source: cache?.catalog === undefined ? ("none" as const) : ("cache" as const),
      catalog: cache?.catalog,
    };
    if (!fetchDue(cache, now)) return cached;
    const attemptedAt = iso(now);
    const fetched = yield* getUrlBytes(PLUGIN_CATALOG_URL).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.map((bytes) => parsePluginCatalog(new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => null),
    );
    const next: PluginCatalogCache =
      fetched === null
        ? {
            attemptedAt,
            ...(cache?.fetchedAt === undefined ? {} : { fetchedAt: cache.fetchedAt }),
            ...(cache?.catalog === undefined ? {} : { catalog: cache.catalog }),
          }
        : { attemptedAt, fetchedAt: attemptedAt, catalog: fetched };
    yield* writeAtomic(catalogFile, encodeCache(next)).pipe(Effect.ignore);
    return fetched === null ? cached : { source: "fetched" as const, catalog: fetched };
  });

  /** The installed version of `id`: the folder whose install record names it. */
  const installed = Effect.fn("AgentdPlugins.installed")(function* (id: string) {
    if (!validPluginId(id)) return null;
    const pluginFolder = path.join(cacheRoot, id);
    const versions = yield* fs.readDirectory(pluginFolder).pipe(Effect.orElseSucceed(() => []));
    for (const version of versions.toSorted()) {
      if (!validPluginVersion(version)) continue;
      const folder = path.join(pluginFolder, version);
      const record = yield* fs.readFileString(path.join(folder, PLUGIN_INSTALL_RECORD)).pipe(
        Effect.map((text) => Option.getOrNull(decodePluginInstallRecord(text))),
        Effect.orElseSucceed(() => null),
      );
      if (record === null || record.id !== id || record.version !== version) continue;
      const manifest = yield* fs.readFileString(path.join(folder, PLUGIN_MANIFEST_FILE)).pipe(
        Effect.map((text) => Option.getOrNull(decodePluginManifest(text))),
        Effect.orElseSucceed(() => null),
      );
      return { folder, record, manifest } satisfies Installed;
    }
    return null;
  });

  const installedIds = fs.readDirectory(cacheRoot).pipe(
    Effect.map((ids) => ids.filter(validPluginId).toSorted()),
    Effect.orElseSucceed(() => [] as Array<string>),
  );

  /** The hook's command when it can be started, else null. */
  const hookCommand = Effect.fn("AgentdPlugins.hookCommand")(function* (hook: Hook) {
    const declared = hook.manifest?.hooks["before-send"];
    if (declared === undefined) return null;
    const resolved = resolveHookCommand(host.platform, hook.folder, declared.command);
    if (resolved._tag === "Unsafe") return null;
    if (resolved._tag === "File") {
      const exists = yield* fs.exists(resolved.path).pipe(Effect.orElseSucceed(() => false));
      return exists ? { command: resolved.path, args: resolved.args, declared } : null;
    }
    const found = yield* resolveCommandPath(resolved.name, { env: host.env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, host.platform),
      Effect.orElseSucceed(() => null),
    );
    return found === null ? null : { command: found, args: resolved.args, declared };
  });

  /** The project's enabled before-send hooks, installed or not, in id order. */
  const enabledHooks = Effect.fn("AgentdPlugins.enabledHooks")(function* (projectId?: string) {
    const settings = yield* readSettings;
    const ids = new Set([
      ...Object.keys(settings.enabled),
      ...Object.keys(projectId === undefined ? {} : (settings.projects[projectId] ?? {})),
    ]);
    const hooks: Hook[] = [];
    for (const id of [...ids].toSorted()) {
      if (!pluginEnabled(settings, id, projectId)) continue;
      const found = yield* installed(id);
      // Enabled and gone, or without a before-send hook: the former stops sends, the latter is inert.
      if (found !== null && found.manifest?.hooks["before-send"] === undefined) continue;
      hooks.push({
        id,
        name: found?.manifest?.name ?? id,
        folder: found?.folder ?? path.join(cacheRoot, id),
        manifest: found?.manifest ?? null,
      });
    }
    return hooks;
  });

  const listing = Effect.fn("AgentdPlugins.listing")(function* (
    source: AgentdPlugins["source"],
    served: PluginCatalog | undefined,
    projectId?: string,
  ) {
    const settings = yield* readSettings;
    const entries = new Map((served?.plugins ?? []).map((entry) => [entry.id, entry]));
    const ids = new Set([...entries.keys(), ...(yield* installedIds)]);
    const plugins = [];
    let beforeSend = false;
    for (const id of [...ids].toSorted()) {
      const entry = entries.get(id);
      const found = yield* installed(id);
      if (entry === undefined && found === null) continue;
      const enabled = pluginEnabled(settings, id, projectId);
      const hooks =
        found?.manifest?.hooks["before-send"] === undefined ? [] : ["before-send" as const];
      const ready =
        found !== null &&
        hooks.length > 0 &&
        (yield* hookCommand({ id, name: id, folder: found.folder, manifest: found.manifest })) !==
          null;
      const state =
        found === null
          ? "absent"
          : !enabled
            ? "off"
            : ready || hooks.length === 0
              ? "on"
              : "missing";
      if (enabled && ready) beforeSend = true;
      const projectEnabled =
        projectId === undefined ? undefined : settings.projects[projectId]?.[id];
      plugins.push({
        id,
        name: found?.manifest?.name ?? entry?.name ?? id,
        description: entry?.description ?? "",
        author: entry?.author ?? "",
        licence: entry?.licence ?? "",
        version: entry?.version ?? found?.record.version ?? "",
        ...(found === null ? {} : { installedVersion: found.record.version }),
        hooks,
        enabled: settings.enabled[id] === true,
        ...(projectEnabled === undefined ? {} : { projectEnabled }),
        state,
      } as const);
    }
    return { source, plugins, beforeSend } satisfies AgentdPlugins;
  });

  const list = Effect.fn("AgentdPlugins.list")(function* (input: AgentdPluginsListInput) {
    const served = yield* catalog();
    return yield* listing(served.source, served.catalog, input.projectId);
  });

  const filesystem = (what: string) => () =>
    new AgentdPluginError({ reason: "filesystem", message: `Could not ${what}.` });

  /** Deletes only the files the install record lists that still resolve inside the folder. */
  const removeInstall = Effect.fn("AgentdPlugins.removeInstall")(function* (found: Installed) {
    const real = yield* fs
      .realPath(found.folder)
      .pipe(Effect.mapError(filesystem(`read ${found.folder}`)));
    const parents = new Set<string>();
    for (const file of found.record.files) {
      const target = resolveInside(host.platform, found.folder, file);
      if (target === null) continue;
      const resolved = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => null));
      const inside = resolved === null ? null : path.relative(real, resolved);
      if (inside === null || inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
        continue;
      }
      yield* fs.remove(target).pipe(Effect.mapError(filesystem(`remove ${target}`)));
      for (
        let dir = path.dirname(target);
        dir.length > found.folder.length;
        dir = path.dirname(dir)
      )
        parents.add(dir);
    }
    yield* fs
      .remove(path.join(found.folder, PLUGIN_INSTALL_RECORD))
      .pipe(Effect.mapError(filesystem(`remove ${found.folder}`)));
    const pluginFolder = path.dirname(found.folder);
    // Deepest first; a folder still holding something the install did not write stays.
    for (const dir of [...parents, found.folder, pluginFolder].toSorted(
      (a, b) => b.length - a.length,
    )) {
      const left = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => ["?"]));
      if (left.length === 0) yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
    }
  });

  const install = Effect.fn("AgentdPlugins.install")(function* (input: AgentdPluginInput) {
    const served = yield* catalog();
    const entry = served.catalog?.plugins.find((plugin) => plugin.id === input.id);
    if (entry === undefined) return yield* fail("unknown", `${input.id} is not in the catalogue.`);
    if (!validPluginVersion(entry.version)) {
      return yield* fail("unsafe", `${entry.version} is not a safe version name.`);
    }
    const repository = githubRepository(entry.source.url);
    if (repository === null) {
      return yield* fail("download", `${entry.source.url} is not a GitHub repository.`);
    }
    const pinned = {
      repository,
      commit: entry.source.sha,
      path: entry.source.path,
      notices: entry.source.notices,
    };
    const files = yield* downloadPinned(pinned, PLUGIN_LAYOUT).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(
        (error) =>
          new AgentdPluginError({
            reason: error.reason === "download" ? "download" : "unsafe",
            message: error.message,
          }),
      ),
    );
    const manifestFile = files.find((file) => file.target === PLUGIN_MANIFEST_FILE);
    const manifest =
      manifestFile === undefined
        ? null
        : Option.getOrNull(decodePluginManifest(new TextDecoder().decode(manifestFile.bytes)));
    if (manifest === null || manifest.id !== entry.id || manifest.version !== entry.version) {
      return yield* fail(
        "invalid",
        `${PLUGIN_MANIFEST_FILE} at commit ${entry.source.sha} does not describe ${entry.id} ${entry.version}.`,
      );
    }
    const before = yield* installed(entry.id);
    const folder = path.join(cacheRoot, entry.id, entry.version);
    const staging = path.join(cacheRoot, entry.id, `.${entry.version}.staging-${stagingSuffix()}`);
    const record: PluginInstallRecord = {
      schemaVersion: 1,
      id: entry.id,
      version: entry.version,
      repository,
      commit: entry.source.sha,
      path: entry.source.path,
      installedAt: iso(yield* Clock.currentTimeMillis),
      files: files.map((file) => file.target),
    };
    const writeStaging = Effect.gen(function* () {
      yield* fs.makeDirectory(staging, { recursive: true });
      for (const file of files) {
        const target = resolveInside(host.platform, staging, file.target);
        if (target === null) return yield* fail("unsafe", `${file.target} has an unsafe path.`);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, file.bytes);
        // A hook that is a file of the plugin has to be executable; git's mode is not kept.
        if (manifest.hooks["before-send"]?.command[0]?.replace(/^\.\//, "") === file.target) {
          yield* fs.chmod(target, 0o755);
        }
      }
      yield* fs.writeFileString(path.join(staging, PLUGIN_INSTALL_RECORD), encodeRecord(record));
    });
    yield* Effect.gen(function* () {
      if (before !== null && before.folder === folder) yield* removeInstall(before);
      yield* writeStaging;
      yield* fs.rename(staging, folder);
    }).pipe(
      Effect.mapError((error) => (isPluginError(error) ? error : filesystem(`write ${folder}`)())),
      Effect.tapError(() =>
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    if (before !== null && before.folder !== folder)
      yield* removeInstall(before).pipe(Effect.ignore);
    return yield* listing(served.source, served.catalog);
  }, lock.withPermits(1));

  const remove = Effect.fn("AgentdPlugins.remove")(function* (input: AgentdPluginInput) {
    const found = yield* installed(input.id);
    if (found === null) return yield* fail("unknown", `${input.id} is not installed.`);
    yield* removeInstall(found);
    const settings = yield* readSettings;
    yield* writeAtomic(settingsFile, encodeSettings(withoutPlugin(settings, input.id))).pipe(
      Effect.mapError(filesystem("save the plugin settings")),
    );
    const served = yield* catalog();
    return yield* listing(served.source, served.catalog);
  }, lock.withPermits(1));

  const setEnabled = Effect.fn("AgentdPlugins.setEnabled")(function* (
    input: AgentdPluginEnableInput,
  ) {
    if (input.enabled !== null && (yield* installed(input.id)) === null) {
      return yield* fail("unknown", `${input.id} is not installed.`);
    }
    if (input.enabled === null && input.projectId === undefined) {
      return yield* fail("invalid", "Only a project's setting can be cleared.");
    }
    const settings = yield* readSettings;
    yield* writeAtomic(
      settingsFile,
      encodeSettings(withPluginEnabled(settings, input.id, input.enabled, input.projectId)),
    ).pipe(Effect.mapError(filesystem("save the plugin settings")));
    const served = yield* catalog();
    return yield* listing(served.source, served.catalog, input.projectId);
  }, lock.withPermits(1));

  /** The message's UTF-8 attachments as the hook sees them; images and binary files are not shown. */
  const textAttachments = Effect.fn("AgentdPlugins.textAttachments")(function* (
    threadId: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const shown: AgentdBeforeSendAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "file") continue;
      const file = attachmentFile(threadId, attachment);
      if (file === null) continue;
      const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => null));
      const text = bytes === null ? null : attachmentText(bytes);
      if (text !== null) shown.push({ id: attachment.id, name: attachment.name, text });
    }
    return shown;
  });

  const attachmentFile = (threadId: string, attachment: ChatAttachment) => {
    const claim = planAttachmentClaim({
      attachmentsDir: config.attachmentsDir,
      threadId,
      attachmentId: attachment.id,
    });
    // A pending upload is still where the client put it; a sent one is in the store.
    if (claim.ok) return claim.currentPath;
    return resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  };

  const placeholderFile = (threadId: string) =>
    path.join(placeholderRoot, placeholderFileName(threadId));

  const readPlaceholders = (threadId: ThreadId) =>
    fs.readFileString(placeholderFile(threadId)).pipe(
      Effect.map((text) => {
        const file = Option.getOrNull(decodePlaceholderFile(text));
        return file === null || file.threadId !== threadId ? {} : file.placeholders;
      }),
      Effect.orElseSucceed((): AgentdPlaceholderMap => ({})),
    );

  // Mode 600 from the first byte: the temporary file is created with it, then renamed over.
  const writePlaceholders = Effect.fn("AgentdPlugins.writePlaceholders")(function* (
    threadId: ThreadId,
    placeholders: AgentdPlaceholderMap,
  ) {
    const file = placeholderFile(threadId);
    const temporary = `${file}.${stagingSuffix()}.tmp`;
    yield* fs.makeDirectory(placeholderRoot, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(
      temporary,
      encodePlaceholderFile({ version: 1, threadId, placeholders }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    yield* fs.chmod(temporary, 0o600);
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
  });

  const placeholders = (threadId: ThreadId) => readPlaceholders(threadId);

  const forgetPlaceholders = (threadId: ThreadId) =>
    fs
      .remove(placeholderFile(threadId), { force: true })
      .pipe(Effect.ignore, placeholderLock.withPermits(1));

  const placeholderThreads = fs.readDirectory(placeholderRoot).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => name.endsWith(".json")),
        (name) =>
          fs.readFileString(path.join(placeholderRoot, name)).pipe(
            Effect.map((text) => Option.getOrNull(decodePlaceholderFile(text))?.threadId ?? null),
            Effect.orElseSucceed(() => null),
          ),
      ),
    ),
    Effect.map((ids) => ids.filter((id): id is ThreadId => id !== null)),
    Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []),
  );

  const runHook = Effect.fn("AgentdPlugins.runHook")(function* (
    hook: Hook,
    request: BeforeSendRequest,
    content: AgentdBeforeSendContent,
    unshown: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    map: AgentdPlaceholderMap,
  ) {
    const fix = "Install it again or turn it off on the AgentD page.";
    const command = yield* hookCommand(hook);
    if (command === null) {
      return yield* blocked(`${hook.name} is turned on but its hook cannot be found. ${fix}`);
    }
    const output = yield* runner
      .run({
        command: command.command,
        args: command.args,
        cwd: hook.folder,
        stdin: hookInput({
          content,
          unshown,
          projectId: request.projectId,
          threadId: request.threadId,
          source: request.source,
          placeholders: map,
        }),
        timeout: Duration.seconds(command.declared.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: HOOK_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError((error) =>
          blocked(
            error._tag === "ProcessSpawnError"
              ? `${hook.name} could not be started. ${fix}`
              : error._tag === "ProcessTimeoutError"
                ? `${hook.name} did not answer in time, so the message was not sent.`
                : `${hook.name} gave no usable answer, so the message was not sent.`,
          ),
        ),
      );
    if (output.timedOut) {
      return yield* blocked(`${hook.name} did not answer in time, so the message was not sent.`);
    }
    if (output.code !== 0) {
      return yield* blocked(
        `${hook.name} failed (exit ${String(output.code)}), so the message was not sent.`,
      );
    }
    const decision = parseHookOutput(output.stdout, content, map);
    if (decision._tag === "Invalid") {
      return yield* blocked(`${hook.name} gave no usable answer, so the message was not sent.`);
    }
    if (decision._tag === "Block") {
      return yield* blocked(
        decision.reason.length > 0
          ? `${hook.name}: ${decision.reason}`
          : `${hook.name} stopped this message.`,
      );
    }
    return decision._tag === "Rewrite"
      ? { content: decision.content, placeholders: decision.placeholders }
      : { content, placeholders: map };
  });

  const hasBeforeSend = Effect.fn("AgentdPlugins.hasBeforeSend")(function* (projectId: ProjectId) {
    return (yield* enabledHooks(projectId)).length > 0;
  });

  const newReviewId = Effect.sync(() => `review-${stagingSuffix()}${stagingSuffix()}`);

  const dropExpired = (now: number) =>
    Ref.update(reviews, (held) => {
      const next = new Map(held);
      for (const [id, review] of held) if (review.expiresAt <= now) next.delete(id);
      return next;
    });

  const checkBeforeSend = Effect.fn("AgentdPlugins.checkBeforeSend")(function* (
    request: BeforeSendRequest,
  ) {
    const hooks = yield* enabledHooks(request.projectId);
    if (hooks.length === 0) return;
    const original: AgentdBeforeSendContent = {
      text: request.text,
      attachments: yield* textAttachments(request.threadId, request.attachments),
    };
    const unshown = request.attachments
      .filter((attachment) => !original.attachments.some((shown) => shown.id === attachment.id))
      .map((attachment) => ({ id: attachment.id, name: attachment.name }));
    const known = yield* readPlaceholders(request.threadId);
    let content = original;
    let map = known;
    const changedBy: string[] = [];
    for (const hook of hooks) {
      const next = yield* runHook(hook, request, content, unshown, map);
      if (!sameContent(next.content, content)) changedBy.push(hook.name);
      content = next.content;
      map = next.placeholders;
    }
    if (sameContent(content, original)) return;
    if (request.resend === undefined) {
      return yield* blocked(
        `${changedBy.join(", ")} would change this message, and a change needs review in the app, so it was not sent.`,
      );
    }
    const now = yield* Clock.currentTimeMillis;
    yield* dropExpired(now);
    const reviewId = yield* newReviewId;
    const review: AgentdBeforeSendReview = {
      reviewId,
      threadId: request.threadId,
      messageId: request.messageId,
      plugins: changedBy,
      original,
      proposed: content,
      placeholders: placeholdersIn(content, map).map((placeholder) => ({
        placeholder,
        value: map[placeholder] ?? "",
        new: !Object.hasOwn(known, placeholder),
      })),
    };
    const resend = request.resend;
    yield* Ref.update(reviews, (held) => {
      const next = new Map(held);
      // One review per message: a second send of it replaces the first.
      for (const [id, other] of held) {
        if (
          other.review.threadId === request.threadId &&
          other.review.messageId === request.messageId
        )
          next.delete(id);
      }
      next.set(reviewId, {
        review,
        placeholders: map,
        attachments: request.attachments,
        resend,
        expiresAt: now + REVIEW_TTL_MS,
      });
      return next;
    });
    return yield* new AgentdBeforeSendError({
      reason: "review",
      message: `${changedBy.join(", ")} changed this message. Review the change before it is sent.`,
      reviewId,
    });
  });

  const review = Effect.fn("AgentdPlugins.review")(function* (input: AgentdBeforeSendReviewInput) {
    yield* dropExpired(yield* Clock.currentTimeMillis);
    const held = yield* Ref.get(reviews);
    for (const entry of held.values()) {
      if (entry.review.threadId === input.threadId && entry.review.messageId === input.messageId) {
        return entry.review;
      }
    }
    return null;
  });

  /** Writes the confirmed text over a held upload; only uploads not yet sent can change. */
  const applyAttachments = Effect.fn("AgentdPlugins.applyAttachments")(function* (
    held: HeldReview,
    confirmed: ReadonlyArray<AgentdBeforeSendAttachment>,
  ) {
    const byId = new Map(confirmed.map((attachment) => [attachment.id, attachment.text]));
    const shown = new Map(held.review.original.attachments.map((a) => [a.id, a.text]));
    const result: ChatAttachment[] = [];
    for (const attachment of held.attachments) {
      const text = byId.get(attachment.id);
      if (text === undefined || text === shown.get(attachment.id) || attachment.type !== "file") {
        result.push(attachment);
        continue;
      }
      const claim = planAttachmentClaim({
        attachmentsDir: config.attachmentsDir,
        threadId: held.review.threadId,
        attachmentId: attachment.id,
      });
      const bytes = new TextEncoder().encode(text);
      if (!claim.ok || bytes.byteLength === 0) {
        return yield* blocked(
          `${attachment.name} cannot be changed here, so the message was not sent.`,
        );
      }
      yield* fs
        .writeFile(claim.currentPath, bytes)
        .pipe(Effect.mapError(() => blocked(`${attachment.name} could not be saved.`)));
      result.push({ ...attachment, sizeBytes: bytes.byteLength });
    }
    return result;
  });

  /**
   * Adds the review's placeholders to the thread's map. Another message confirmed meanwhile may
   * have numbered the same placeholder for someone else: then this one has to be checked again.
   */
  const storePlaceholders = Effect.fn("AgentdPlugins.storePlaceholders")(function* (
    held: HeldReview,
  ) {
    const threadId = held.review.threadId;
    const stored = yield* readPlaceholders(threadId);
    const added = Object.entries(held.placeholders).filter(
      ([placeholder]) => !Object.hasOwn(stored, placeholder),
    );
    if (
      Object.entries(stored).some(
        ([placeholder, value]) =>
          Object.hasOwn(held.placeholders, placeholder) && held.placeholders[placeholder] !== value,
      )
    ) {
      return yield* blocked(
        "Another message in this conversation was confirmed while this one waited, and its placeholders changed. Send this message again.",
      );
    }
    if (added.length === 0) return;
    yield* writePlaceholders(threadId, { ...stored, ...Object.fromEntries(added) }).pipe(
      Effect.mapError(() =>
        blocked("The placeholders for this conversation could not be saved, so it was not sent."),
      ),
    );
  }, placeholderLock.withPermits(1));

  const confirm = Effect.fn("AgentdPlugins.confirm")(function* (
    input: AgentdBeforeSendConfirmInput,
  ) {
    yield* dropExpired(yield* Clock.currentTimeMillis);
    const held = (yield* Ref.get(reviews)).get(input.reviewId);
    if (held === undefined) {
      return yield* blocked("This review is no longer open. Send the message again.");
    }
    yield* Ref.update(reviews, (all) => {
      const next = new Map(all);
      next.delete(input.reviewId);
      return next;
    });
    yield* storePlaceholders(held);
    const attachments = yield* applyAttachments(held, input.content.attachments);
    const text = input.content.text;
    const resend = held.resend;
    if (resend.kind === "launch") {
      const initialMessage = resend.input.initialMessage;
      if (initialMessage === undefined) return resend;
      return {
        kind: "launch",
        input: { ...resend.input, initialMessage: { ...initialMessage, text, attachments } },
      } satisfies BeforeSendResend;
    }
    const command = resend.command;
    if (command.type === "message.dispatch" || command.type === "queued-run.edit") {
      return {
        kind: "dispatch",
        command: { ...command, text, attachments },
      } satisfies BeforeSendResend;
    }
    return resend;
  });

  const discard = (reviewId: string) =>
    Ref.update(reviews, (held) => {
      const next = new Map(held);
      next.delete(reviewId);
      return next;
    });

  return AgentdPluginsService.of({
    list,
    install,
    remove,
    setEnabled,
    hasBeforeSend,
    checkBeforeSend,
    review,
    confirm,
    discard,
    placeholders,
    forgetPlaceholders,
    placeholderThreads,
  });
});

export const layer = Layer.effect(AgentdPluginsService, make);
/** One value, so the runtime and the RPC handlers share one service and its held reviews. */
export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));
