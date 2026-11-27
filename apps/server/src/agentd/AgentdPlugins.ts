import {
  AgentdBeforeSendError,
  AgentdPluginError,
  type AgentdBeforeSendAttachment,
  type AgentdBeforeSendConfirmInput,
  type AgentdBeforeSendContent,
  type AgentdBeforeSendReview,
  type AgentdBeforeSendReviewInput,
  type AgentdPlaceholderMap,
  type AgentdPluginCatalogState,
  type AgentdPluginDeveloperModeInput,
  type AgentdPluginEnableInput,
  type AgentdPluginLocalInput,
  type AgentdPluginOrigin,
  type AgentdPluginSourceInput,
  type AgentdPluginSourceListing,
  type AgentdPluginSourceRemoveInput,
  type AgentdPluginErrorReason,
  type AgentdPluginInput,
  type AgentdPluginRemoveInput,
  type AgentdPluginSettingsInput,
  type AgentdPluginMcpServer,
  type AgentdPluginSettingListing,
  type AgentdPluginSetup,
  type AgentdPlugins,
  type AgentdPluginsListInput,
  ChatAttachmentId,
  type ChatAttachment,
  type CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveCommandPaths } from "@t3tools/shared/shell";
import {
  APP_MCP_DIRECT_SERVER_NAME,
  APP_MCP_SERVER_NAME,
} from "@t3tools/shared/t3McpToolPresentation";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { identity } from "effect/Function";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  createPendingAttachmentId,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AgentdGitHubConnection from "./agentdGitHubConnection.ts";
import { downloadPinned, getUrlBytes, type PinnedFetch } from "./AgentdSkills.ts";
import {
  CLAUDE_MARKETPLACE_FILE,
  CLAUDE_MCP_FILE,
  CLAUDE_PLUGIN_FILE,
  expandMcpServer,
  parseMarketplace,
  parsePluginFiles,
  pluginCommand,
  serverSettings,
  type ExpandContext,
  type PluginDefinition,
  type PluginSetting,
} from "./claudePluginFormat.ts";
import { findEngine, isEngineCommand } from "./enginePath.ts";
import {
  GITHUB_API,
  OFFICIAL_REPOSITORY,
  PLUGIN_CATALOG_BASE,
  PluginSources,
  type PluginCatalog,
  type PluginOrigin,
  linkedPlugin,
  parsePluginKey,
  parseSourceLink,
  pluginKey,
  readPluginSources,
  sortPluginKeys,
  sourceCatalogUrl,
  sourceRepository,
  sourceSegment,
  sourceTokenName,
  tokenAllowed,
  PLUGIN_INSTALL_RECORD,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_SOURCE,
  PluginCatalogCache,
  PluginInstallRecord,
  PluginSettings,
  PluginSetupRecord,
  PlaceholderFile,
  type HookProgram,
  type HookUnshownAttachment,
  type ResolvedCommand,
  type PluginMcpLaunch,
  pluginSecretName,
  withPluginValues,
  attachmentText,
  decodePlaceholderFile,
  decodePluginCatalogCache,
  decodePluginInstallRecord,
  decodePluginSetupRecord,
  hookInput,
  hookPrograms,
  isWindowsAppsPath,
  lastLine,
  parseHookOutput,
  parsePluginCatalog,
  placeholderFileName,
  placeholdersIn,
  pluginEnabled,
  readPluginSettings,
  resolveHookCommand,
  sameContent,
  scriptPrograms,
  setupReady,
  validPluginVersion,
  withPluginEnabled,
  withoutPlugin,
} from "./pluginCatalog.ts";
import {
  fetchDue,
  githubRepository,
  resolveInside,
  stagingSuffix,
  urlPath,
  type HostPaths,
} from "./skillCatalog.ts";

// Enabled before-send hooks run in id order, each on the previous one's output; any block, failure
// or missing command stops the send. A reviewable rewrite is held until confirmed or closed.
// Message text never goes to logs or spans: hook stdout and stderr are read and dropped. Nor does a
// thread's placeholder map, kept in plugins/placeholders/ readable by this user alone.

const REQUEST_TIMEOUT = Duration.seconds(20);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * A GitHub URL's body, read with a catalogue's token only where it may go: api.github.com, for
 * that repository. Redirects are followed here rather than by fetch, and without the token from
 * the first one on, wherever they lead. Failures name the URL, never the token.
 */
const getWithToken = Effect.fn("AgentdPlugins.getWithToken")(function* (
  url: string,
  repository: string,
  token: string,
) {
  const http = yield* HttpClient.HttpClient;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const at = current;
    const carry = hop === 0 && tokenAllowed(at, repository);
    const request = HttpClientRequest.get(at).pipe(
      HttpClientRequest.setHeader(
        "accept",
        at.includes("/git/trees/")
          ? "application/vnd.github+json"
          : "application/vnd.github.raw+json",
      ),
      carry ? HttpClientRequest.bearerToken(token) : identity,
    );
    const response = yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(() => `${at}: the request failed`),
    );
    if (REDIRECTS.has(response.status)) {
      const next = redirectTarget(response.headers["location"], at);
      if (next === null)
        return yield* Effect.fail(`${at}: HTTP ${response.status} to nowhere usable`);
      current = next;
      continue;
    }
    if (response.status !== 200) return yield* Effect.fail(`${at}: HTTP ${response.status}`);
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(() => `${at}: the response could not be read`),
    );
    return new Uint8Array(buffer);
  }
  return yield* Effect.fail(`${url}: too many redirects`);
});

function redirectTarget(location: string | undefined, base: string): string | null {
  if (location === undefined) return null;
  try {
    const next = new URL(location, base);
    return next.protocol === "https:" ? next.toString() : null;
  } catch {
    return null;
  }
}

/** A pinned folder of the token's own repository: tree and files from the API, with the token. */
const tokenFetch = (repository: string, token: string): PinnedFetch => ({
  get: (url) => getWithToken(url, repository, token),
  fileUrl: (entry, file) =>
    `${GITHUB_API}/repos/${urlPath(entry.repository)}/git/blobs/${file.sha}`,
});

// A token is printable ASCII with no space, so it cannot break a header.
const TOKEN = /^[\x21-\x7e]{1,512}$/;

/** How a GitHub source is read: anonymously, with its kept token, or with the GitHub connection. */
type SourceAuth =
  | { readonly kind: "anonymous" }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "connection" };

const NO_CONNECTION = "no GitHub connection";
const NO_CONNECTION_MESSAGE =
  "LibraOS Next has no GitHub connection that can read this repository. Sign in with GitHub, or run gh auth login, and try again; or give a read-only token for this repository.";

/**
 * The commands whose hooks the intake ran, so the dispatch backstop does not run them again.
 * Only those ids: anything else dispatched inside the same call is still checked.
 */
export const BeforeSendChecked = Context.Reference<ReadonlySet<CommandId>>(
  "t3/agentd/AgentdPlugins/BeforeSendChecked",
  { defaultValue: () => new Set() },
);

/** The first of `programs` found on PATH, or null when none is. */
const findProgram = Effect.fn("AgentdPlugins.findProgram")(
  function* (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    programs: ReadonlyArray<HookProgram>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const program of programs) {
      const matches = program.skipWindowsApps
        ? yield* resolveCommandPaths(program.name, {
            env,
            until: (match) => !isWindowsAppsPath(match),
          })
        : [yield* resolveCommandPath(program.name, { env })];
      for (const match of matches) {
        if (match === null) continue;
        // A Store install of Python leaves its package folder beside the alias; the stub does not.
        const usable =
          !program.skipWindowsApps ||
          !isWindowsAppsPath(match) ||
          (yield* fs.readDirectory(path.dirname(match)).pipe(Effect.orElseSucceed(() => []))).some(
            (entry) => entry.startsWith("PythonSoftwareFoundation.Python."),
          );
        if (usable) return { command: match, args: program.args };
      }
    }
    return null;
  },
  (effect, platform) => Effect.provideService(effect, HostProcess.Platform, platform),
);

/** A hook's program found on PATH, trying python3's Windows stand-ins, or null when none is. */
export const findHookProgram = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  name: string,
  args: ReadonlyArray<string>,
) => findProgram(platform, env, hookPrograms(platform, name, args));

/** How a hook, setup or MCP server is started, or why it cannot be. */
export type ProgramLaunch =
  | { readonly _tag: "Program"; readonly command: string; readonly args: ReadonlyArray<string> }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "NoPython" };

/** A command inside the plugin's folder, or a program name to look up on PATH. */
export type ProgramLaunchInput = Exclude<ResolvedCommand, { readonly _tag: "Unsafe" }>;

const NOT_FOUND: ProgramLaunch = { _tag: "NotFound" };
const NO_PYTHON: ProgramLaunch = { _tag: "NoPython" };
const PYTHON_INSTALL = "Install Python 3 from python.org (it adds the py launcher)";
/** What a person reads when a Windows .py server has no Python to start it. */
export const noPython = (server: string) =>
  `${server} is a Python script and Python 3 was not found. ${PYTHON_INSTALL}, then start a new thread.`;
/** A setup gets the engine's path in this variable. */
export const LIBRAOS_ENGINE_ENV = "LIBRAOS_ENGINE";

/**
 * How to start a plugin's resolved command. Only Next picks an interpreter: a .py file of the
 * plugin on Windows goes through Python from PATH. An engine name not on PATH runs `engine`.
 */
export const launchProgram = Effect.fn("AgentdPlugins.launchProgram")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  resolved: ProgramLaunchInput,
  engine: string | null,
) {
  if (resolved._tag === "File") {
    const programs = scriptPrograms(platform, resolved.path, resolved.args);
    if (programs === null) return program({ command: resolved.path, args: resolved.args });
    const found = yield* findProgram(platform, env, programs);
    return found === null ? NO_PYTHON : program(found);
  }
  const found = yield* findHookProgram(platform, env, resolved.name, resolved.args);
  if (found !== null) return program(found);
  return engine !== null && isEngineCommand(platform, resolved.name)
    ? program({ command: engine, args: resolved.args })
    : NOT_FOUND;
});

const program = (found: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): ProgramLaunch => ({ _tag: "Program", command: found.command, args: found.args });

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
    readonly remove: (
      input: AgentdPluginRemoveInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /** Starts the installed plugin's setup in the background; the listing shows how it goes. */
    readonly setup: (input: AgentdPluginInput) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /** Saves the plugin's settings: secret ones in the secret store, the rest in settings.json. */
    readonly setSettings: (
      input: AgentdPluginSettingsInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /**
     * The MCP servers of the plugins on in the project, ready to start, by server name. A server
     * whose command is gone, whose setup has not run or that lacks a setting is left out.
     */
    readonly mcpServers: (
      projectId: ProjectId,
    ) => Effect.Effect<Readonly<Record<string, PluginMcpLaunch>>>;
    /** Waits until no setup of `id` is running. */
    readonly setupDone: (id: string) => Effect.Effect<void>;
    readonly setEnabled: (
      input: AgentdPluginEnableInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /** Adds a GitHub catalogue, or replaces its token, once its catalog.json reads. */
    readonly addSource: (
      input: AgentdPluginSourceInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    readonly removeSource: (
      input: AgentdPluginSourceRemoveInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    readonly setDeveloperMode: (
      input: AgentdPluginDeveloperModeInput,
    ) => Effect.Effect<AgentdPlugins, AgentdPluginError>;
    /** Developer mode: a local folder as a plugin, read from there every time. */
    readonly addLocal: (
      input: AgentdPluginLocalInput,
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
// A 2 GB download at about 5 Mbit/s takes 55 minutes; a slower line can run setup again, and it
// keeps what it already downloaded.
const SETUP_TIMEOUT_MINUTES = 60;
const SETUP_MAX_OUTPUT_BYTES = 1024 * 1024;
const PLUGIN_LAYOUT = {
  required: [CLAUDE_PLUGIN_FILE, PLUGIN_MANIFEST_FILE],
  manifest: PLUGIN_INSTALL_RECORD,
};

const REMOTE_SERVER = "A remote server is not given to agents yet; only a program is.";

const fail = (reason: AgentdPluginErrorReason, message: string) =>
  Effect.fail(new AgentdPluginError({ reason, message }));
const blocked = (message: string) => new AgentdBeforeSendError({ reason: "blocked", message });

const encodeCache = Schema.encodeSync(Schema.fromJsonString(PluginCatalogCache));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(PluginInstallRecord));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(PluginSettings));
const encodeSetup = Schema.encodeSync(Schema.fromJsonString(PluginSetupRecord));
const encodePlaceholderFile = Schema.encodeSync(Schema.fromJsonString(PlaceholderFile));
const encodeSources = Schema.encodeSync(Schema.fromJsonString(PluginSources));
const isPluginError = Schema.is(AgentdPluginError);

interface Installed {
  /** Per source; what settings, secrets, setup and data are kept under. */
  readonly key: string;
  readonly origin: PluginOrigin;
  readonly folder: string;
  readonly record: PluginInstallRecord;
  readonly manifest: PluginDefinition | null;
  /** A local plugin whose manifest is refused now. */
  readonly problems?: ReadonlyArray<string>;
}

/** One catalogue as read now. */
interface Served {
  readonly origin: PluginOrigin;
  readonly repository: string;
  readonly hasToken: boolean;
  readonly connection: boolean;
  readonly state: AgentdPluginCatalogState;
  readonly catalog: PluginCatalog | undefined;
}

interface Catalogs {
  readonly sources: PluginSources;
  readonly served: ReadonlyArray<Served>;
}

const sameOrigin = (a: PluginOrigin, b: PluginOrigin) =>
  a.kind === b.kind &&
  (a.kind !== "github" || (b.kind === "github" && a.repository === b.repository));

/** A GitHub plugin's catalogue is still a source; the official one and local folders always are. */
const isSource = (origin: PluginOrigin, sources: PluginSources) =>
  origin.kind !== "github" ||
  sources.github.some((known) => known.repository === origin.repository);

interface Hook {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly manifest: PluginDefinition | null;
  /** Its manifest declares setup and the last one did not succeed for this install. */
  readonly needsSetup: boolean;
}

interface RunningSetup {
  /** The last line setup printed; written by its stdout callback. */
  progress: string | null;
  readonly done: Deferred.Deferred<void>;
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
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const github = yield* AgentdGitHubConnection.AgentdGitHubConnection;
  const host: HostPaths = {
    platform: yield* HostProcess.Platform,
    home: yield* HostProcess.HomeDirectory,
    env: yield* HostProcess.Environment,
  };
  const root = path.join(config.stateDir, "plugins");
  const cacheBase = path.join(root, "cache");
  const catalogFile = path.join(root, "catalog.json");
  // The catalogues a person added (their tokens are in the secret store) and developer mode.
  const sourcesFile = path.join(root, "sources.json");
  const catalogsRoot = path.join(root, "catalogs");
  const settingsFile = path.join(root, "settings.json");
  const lock = yield* Semaphore.make(1);
  const reviews = yield* Ref.make(new Map<string, HeldReview>());
  const setupRoot = path.join(root, "setup");
  const dataRoot = path.join(root, "data");
  const running = yield* Ref.make(new Map<string, RunningSetup>());
  const scope = yield* Scope.Scope;
  const placeholderRoot = path.join(root, "placeholders");
  const placeholderLock = yield* Semaphore.make(1);
  // A secret setting a server reads from a file; only this user can read the folder.
  const secretFilesRoot = path.join(root, "secret-files");

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

  const readSources = fs.readFileString(sourcesFile).pipe(
    Effect.map(readPluginSources),
    Effect.orElseSucceed(() => readPluginSources("")),
  );
  const writeSources = (sources: PluginSources) =>
    writeAtomic(sourcesFile, encodeSources(sources)).pipe(
      Effect.mapError(filesystem("save the plugin sources")),
    );

  const readCacheAt = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrNull(decodePluginCatalogCache(text))),
      Effect.orElseSucceed(() => null),
    );

  /** A catalogue from its cache, fetched again when a day has passed or `force`. */
  const fetchCatalog = Effect.fn("AgentdPlugins.fetchCatalog")(function* (
    file: string,
    get: Effect.Effect<PluginCatalog | null, string>,
    force: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cache = yield* readCacheAt(file);
    const cached = {
      state: cache?.catalog === undefined ? ("none" as const) : ("cache" as const),
      catalog: cache?.catalog,
      failure: undefined as string | undefined,
    };
    if (!force && !fetchDue(cache, now)) return cached;
    const attemptedAt = iso(now);
    const result = yield* get.pipe(Effect.result);
    const fetched = result._tag === "Success" ? result.success : null;
    const next: PluginCatalogCache =
      fetched === null
        ? {
            attemptedAt,
            ...(cache?.fetchedAt === undefined ? {} : { fetchedAt: cache.fetchedAt }),
            ...(cache?.catalog === undefined ? {} : { catalog: cache.catalog }),
          }
        : { attemptedAt, fetchedAt: attemptedAt, catalog: fetched };
    yield* writeAtomic(file, encodeCache(next)).pipe(Effect.ignore);
    if (fetched !== null)
      return { state: "fetched" as const, catalog: fetched, failure: undefined };
    return {
      ...cached,
      failure:
        result._tag === "Failure" ? result.failure : "catalog.json is not a plugin catalogue",
    };
  });

  const sourceToken = (repository: string) =>
    secrets.get(sourceTokenName(repository)).pipe(
      Effect.map((bytes) =>
        Option.isNone(bytes) ? undefined : new TextDecoder().decode(bytes.value),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const sourceCacheFile = (repository: string) =>
    path.join(catalogsRoot, `${sourceSegment(repository)}.json`);

  /** A kept token first; else the GitHub connection, only where the person confirmed it. */
  const sourceAuth = Effect.fn("AgentdPlugins.sourceAuth")(function* (
    repository: string,
    sources: PluginSources,
  ) {
    const token = yield* sourceToken(repository);
    if (token !== undefined) return { kind: "token", token } satisfies SourceAuth;
    return sources.github.some(
      (known) => known.repository === repository && known.githubConnection === true,
    )
      ? ({ kind: "connection" } satisfies SourceAuth)
      : ({ kind: "anonymous" } satisfies SourceAuth);
  });

  // Asked of the connection for each fetch, for a source the person confirmed, and never kept,
  // logged or put in an error here.
  const connectionToken = Effect.fn("AgentdPlugins.connectionToken")(function* (
    repository: string,
  ) {
    const held = yield* github.credential(repository);
    const token = Option.isSome(held) ? Redacted.value(held.value) : "";
    return TOKEN.test(token) ? token : undefined;
  });

  /** A GitHub URL's body as `auth` reads it; the connection is asked when the request is made. */
  const readAs = (repository: string, auth: SourceAuth, url: string) =>
    (auth.kind === "anonymous"
      ? getUrlBytes(url)
      : auth.kind === "token"
        ? getWithToken(url, repository, auth.token)
        : connectionToken(repository).pipe(
            Effect.flatMap((token) =>
              token === undefined
                ? Effect.fail(NO_CONNECTION)
                : getWithToken(url, repository, token),
            ),
          )
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));

  /** A repository's marketplace when it reads as one, else its version 1 `catalog.json`. */
  const readCatalog = Effect.fn("AgentdPlugins.readCatalog")(function* (
    get: (file: string) => Effect.Effect<Uint8Array, string>,
  ) {
    const marketplace = yield* get(CLAUDE_MARKETPLACE_FILE).pipe(
      Effect.map((bytes) => parseMarketplace(new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => null),
    );
    if (marketplace !== null) return marketplace;
    return parsePluginCatalog(new TextDecoder().decode(yield* get("catalog.json")));
  });

  const githubCatalog = Effect.fn("AgentdPlugins.githubCatalog")(function* (
    repository: string,
    auth: SourceAuth,
    force: boolean,
  ) {
    // One read asks the connection once, though it may fetch two files.
    const token = yield* Effect.cached(connectionToken(repository));
    const get = (file: string) => {
      const url = sourceCatalogUrl(repository, auth.kind !== "anonymous", file);
      return auth.kind !== "connection"
        ? readAs(repository, auth, url)
        : token.pipe(
            Effect.flatMap((held) =>
              held === undefined ? Effect.fail(NO_CONNECTION) : getWithToken(url, repository, held),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          );
    };
    return yield* fetchCatalog(sourceCacheFile(repository), readCatalog(get), force);
  });

  /** Every catalogue: the official one first, then those a person added. */
  const catalogs = Effect.fn("AgentdPlugins.catalogs")(function* () {
    const sources = yield* readSources;
    const official = yield* fetchCatalog(
      catalogFile,
      readCatalog((file) =>
        getUrlBytes(`${PLUGIN_CATALOG_BASE}/${file}`).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      ),
      false,
    );
    const served: Served[] = [
      {
        origin: { kind: "official" },
        repository: OFFICIAL_REPOSITORY,
        hasToken: false,
        connection: false,
        ...official,
      },
    ];
    for (const { repository } of sources.github) {
      const auth = yield* sourceAuth(repository, sources);
      const read = yield* githubCatalog(repository, auth, false);
      served.push({
        origin: { kind: "github", repository },
        repository,
        hasToken: auth.kind === "token",
        connection: auth.kind === "connection",
        state: read.state,
        catalog: read.catalog,
      });
    }
    return { sources, served } satisfies Catalogs;
  });

  /** The cache folder of a source: `libraos` for the official one, as before sources existed. */
  const sourceFolder = (origin: PluginOrigin) =>
    origin.kind === "github" ? sourceSegment(origin.repository) : PLUGIN_SOURCE;

  const readDefinition = Effect.fn("AgentdPlugins.readDefinition")(function* (folder: string) {
    const read = (file: string) =>
      fs
        .readFileString(path.join(folder, file))
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    return parsePluginFiles({
      plugin: yield* read(CLAUDE_PLUGIN_FILE),
      mcp: yield* read(CLAUDE_MCP_FILE),
      sidecar: yield* read(PLUGIN_MANIFEST_FILE),
    });
  });

  /** A local plugin in developer mode, its manifest read again now. */
  const installedLocal = Effect.fn("AgentdPlugins.installedLocal")(function* (id: string) {
    const sources = yield* readSources;
    const local = sources.developerMode
      ? sources.local.find((candidate) => candidate.id === id)
      : undefined;
    if (local === undefined) return null;
    const parsed = yield* readDefinition(local.path);
    const manifest = parsed._tag === "Valid" && parsed.plugin.id === id ? parsed.plugin : null;
    const problems =
      parsed._tag === "Invalid"
        ? parsed.reasons
        : manifest === null
          ? [`id: the folder now says ${parsed.plugin.id}, but it was added as ${id}.`]
          : undefined;
    const origin: PluginOrigin = { kind: "local" };
    return {
      key: pluginKey(origin, id),
      origin,
      folder: local.path,
      record: {
        schemaVersion: 1,
        id,
        version: manifest?.version ?? "",
        repository: "local",
        commit: "local",
        path: local.path,
        installedAt: "",
        files: [],
      },
      manifest,
      ...(problems === undefined ? {} : { problems }),
    } satisfies Installed;
  });

  /** The installed version of `key`: the folder whose install record names it. */
  const installed = Effect.fn("AgentdPlugins.installed")(function* (
    key: string,
  ): Effect.fn.Return<Installed | null> {
    const parsed = parsePluginKey(key);
    if (parsed === null) return null;
    if (parsed.origin.kind === "local") return yield* installedLocal(parsed.id);
    const id = parsed.id;
    const pluginFolder = path.join(cacheBase, sourceFolder(parsed.origin), key);
    const versions = yield* fs.readDirectory(pluginFolder).pipe(Effect.orElseSucceed(() => []));
    for (const version of versions.toSorted()) {
      if (!validPluginVersion(version)) continue;
      const folder = path.join(pluginFolder, version);
      const record = yield* fs.readFileString(path.join(folder, PLUGIN_INSTALL_RECORD)).pipe(
        Effect.map((text) => Option.getOrNull(decodePluginInstallRecord(text))),
        Effect.orElseSucceed(() => null),
      );
      if (record === null || record.id !== id || record.version !== version) continue;
      const read = yield* readDefinition(folder);
      const manifest = read._tag === "Valid" ? read.plugin : null;
      return { key, origin: parsed.origin, folder, record, manifest };
    }
    return null;
  });

  /** Every installed key: each source's cache folder, and local plugins in developer mode. */
  const installedKeys = Effect.fn("AgentdPlugins.installedKeys")(function* (
    sources: PluginSources,
  ) {
    const keys: string[] = [];
    const folders = yield* fs.readDirectory(cacheBase).pipe(Effect.orElseSucceed(() => []));
    for (const folder of folders) {
      const names = yield* fs
        .readDirectory(path.join(cacheBase, folder))
        .pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        const parsed = parsePluginKey(name);
        if (parsed === null || parsed.origin.kind === "local") continue;
        if (sourceFolder(parsed.origin) === folder) keys.push(name);
      }
    }
    if (sources.developerMode) {
      keys.push(...sources.local.map((local) => pluginKey({ kind: "local" }, local.id)));
    }
    return keys;
  });

  /** A local plugin is not run while developer mode is off; turning it off stops none of the rest. */
  const runnable = (key: string, sources: PluginSources) =>
    sources.developerMode || parsePluginKey(key)?.origin.kind !== "local";

  const setupFile = (id: string) => path.join(setupRoot, `${id}.json`);
  const readSetup = (id: string) =>
    fs.readFileString(setupFile(id)).pipe(
      Effect.map((text) => Option.getOrNull(decodePluginSetupRecord(text))),
      Effect.orElseSucceed(() => null),
    );

  /** Whether `found` declares setup that has not succeeded; a manifest without setup never does. */
  const needsSetup = Effect.fn("AgentdPlugins.needsSetup")(function* (found: Installed) {
    if (found.manifest?.setup === undefined) return false;
    return !setupReady(yield* readSetup(found.key), found.record);
  });

  const setupListing = Effect.fn("AgentdPlugins.setupListing")(function* (found: Installed) {
    const declared = found.manifest?.setup;
    if (declared === undefined) return undefined;
    const now = (yield* Ref.get(running)).get(found.key);
    if (now !== undefined) {
      return {
        description: declared.description,
        status: "running",
        ...(now.progress === null ? {} : { progress: now.progress }),
      } satisfies AgentdPluginSetup;
    }
    const record = yield* readSetup(found.key);
    const current =
      record !== null &&
      record.version === found.record.version &&
      record.commit === found.record.commit;
    if (!current) return { description: declared.description, status: "needed" } as const;
    return {
      description: declared.description,
      status: record.status,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    } satisfies AgentdPluginSetup;
  });

  /** The hook's command when it can be started, else null. */
  const hookCommand = Effect.fn("AgentdPlugins.hookCommand")(function* (hook: Hook) {
    const declared = hook.manifest?.hooks?.["before-send"];
    if (declared === undefined) return null;
    const found = yield* resolveCommand(hook.folder, declared.command);
    return found._tag === "Program" ? { command: found.command, args: found.args, declared } : null;
  });

  const withPaths = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const engine = findEngine(host.env).pipe(
    Effect.provideService(HostProcess.Platform, host.platform),
    withPaths,
  );

  /** A hook's, setup's or MCP server's argv as a program to start, or why it cannot be. */
  const resolveCommand = Effect.fn("AgentdPlugins.resolveCommand")(function* (
    folder: string,
    argv: ReadonlyArray<string>,
  ) {
    const resolved = resolveHookCommand(host.platform, folder, argv);
    if (resolved._tag === "Unsafe") return NOT_FOUND;
    if (resolved._tag === "File") {
      const exists = yield* fs.exists(resolved.path).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return NOT_FOUND;
    }
    const known =
      resolved._tag === "Path" && isEngineCommand(host.platform, resolved.name)
        ? yield* engine
        : null;
    return yield* launchProgram(host.platform, host.env, resolved, known).pipe(withPaths);
  });

  /** The project's enabled before-send hooks, installed or not, in id order. */
  const enabledHooks = Effect.fn("AgentdPlugins.enabledHooks")(function* (projectId?: string) {
    const settings = yield* readSettings;
    const sources = yield* readSources;
    const ids = new Set([
      ...Object.keys(settings.enabled),
      ...Object.keys(projectId === undefined ? {} : (settings.projects[projectId] ?? {})),
    ]);
    const hooks: Hook[] = [];
    for (const id of sortPluginKeys(ids)) {
      if (!pluginEnabled(settings, id, projectId) || !runnable(id, sources)) continue;
      const found = yield* installed(id);
      // Enabled and gone, or without a before-send hook: the former stops sends, the latter is inert.
      if (found !== null && found.manifest?.hooks?.["before-send"] === undefined) continue;
      hooks.push({
        id,
        name: found?.manifest?.name ?? id,
        folder: found?.folder ?? path.join(cacheBase, id),
        manifest: found?.manifest ?? null,
        needsSetup: found === null ? false : yield* needsSetup(found),
      });
    }
    return hooks;
  });

  const secretValue = (id: string, setting: string) =>
    secrets.get(pluginSecretName(id, setting)).pipe(
      Effect.map((bytes) =>
        Option.isNone(bytes) ? undefined : new TextDecoder().decode(bytes.value),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  /** The settings' values; secret ones are read from the secret store only when `withSecrets`. */
  const settingValues = Effect.fn("AgentdPlugins.settingValues")(function* (
    found: Installed,
    settings: PluginSettings,
    withSecrets: boolean,
  ) {
    const values = new Map<string, string>();
    const given = settings.values?.[found.key] ?? {};
    const secretSet = new Set<string>();
    for (const setting of found.manifest?.settings ?? []) {
      if (!setting.secret) {
        const value = Object.hasOwn(given, setting.name) ? given[setting.name] : undefined;
        if (value !== undefined) values.set(setting.name, value);
        continue;
      }
      const value = yield* secretValue(found.key, setting.name);
      if (value === undefined) continue;
      secretSet.add(setting.name);
      if (withSecrets) values.set(setting.name, value);
    }
    return { values, secretSet };
  });

  const secretFile = (id: string, setting: string) => path.join(secretFilesRoot, id, setting);

  /** What a server's variables stand for; `value` gives each declared setting's. */
  const expandContext = (
    found: Installed,
    value: (setting: PluginSetting) => string | undefined,
  ): ExpandContext => ({
    root: found.folder,
    data: path.join(dataRoot, found.key),
    setting: (name) => {
      const setting = found.manifest?.settings.find((known) => known.name === name);
      return setting === undefined ? undefined : value(setting);
    },
    env: (name) => host.env[name],
  });

  /** What the page shows of a plugin's servers and settings; no secret value is in it. */
  const contributions = Effect.fn("AgentdPlugins.contributions")(function* (
    found: Installed,
    settings: PluginSettings,
  ) {
    const manifest = found.manifest;
    const declared = manifest?.settings ?? [];
    const servers = Object.entries(manifest?.mcpServers ?? {});
    if (declared.length === 0 && servers.length === 0) return undefined;
    const { values, secretSet } = yield* settingValues(found, settings, false);
    const listedSettings = declared.map((setting): AgentdPluginSettingListing => ({
      name: setting.name,
      label: setting.label,
      secret: setting.secret,
      ...(setting.description === undefined ? {} : { description: setting.description }),
      ...(setting.secret
        ? {}
        : (values.get(setting.name) ?? setting.default) === undefined
          ? {}
          : { value: values.get(setting.name) ?? setting.default ?? "" }),
      set: setting.secret ? secretSet.has(setting.name) : values.has(setting.name),
    }));
    const listedServers = yield* Effect.forEach(servers, ([name, server]) =>
      Effect.gen(function* () {
        const expanded = expandMcpServer(
          server,
          expandContext(found, (setting) =>
            setting.secret
              ? secretSet.has(setting.name)
                ? "set"
                : undefined
              : (values.get(setting.name) ?? setting.default),
          ),
        );
        const missing = expanded._tag === "Missing" ? expanded.settings : [];
        if (!("command" in server)) {
          return {
            name,
            command: server.url,
            args: [],
            env: Object.keys(server.headers ?? {}),
            missing,
            problem: REMOTE_SERVER,
          } satisfies AgentdPluginMcpServer;
        }
        const command = pluginCommand(server.command);
        const args = server.args ?? [];
        // Only a Windows .py server is looked up: elsewhere the listing reads no PATH.
        const noInterpreter =
          scriptPrograms(host.platform, command, []) !== null &&
          (yield* resolveCommand(found.folder, [command, ...args]))._tag === "NoPython";
        return {
          name,
          command,
          args,
          env: Object.keys(server.env ?? {}),
          missing,
          ...(noInterpreter ? { problem: noPython(name) } : {}),
        } satisfies AgentdPluginMcpServer;
      }),
    );
    return {
      ...(listedServers.length === 0 ? {} : { mcpServers: listedServers }),
      ...(listedSettings.length === 0 ? {} : { settings: listedSettings }),
    };
  });

  // Mode 600 from the first byte, as the placeholder files are.
  const writeSecretFile = Effect.fn("AgentdPlugins.writeSecretFile")(function* (
    file: string,
    value: string,
  ) {
    const temporary = `${file}.${stagingSuffix()}.tmp`;
    yield* fs.makeDirectory(secretFilesRoot, { recursive: true, mode: 0o700 });
    yield* fs.chmod(secretFilesRoot, 0o700);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(temporary, value, { flag: "wx", mode: 0o600 });
    yield* fs.chmod(temporary, 0o600);
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
  });

  const mcpServers = Effect.fn("AgentdPlugins.mcpServers")(function* (projectId: ProjectId) {
    const settings = yield* readSettings;
    const sources = yield* readSources;
    const ids = new Set([
      ...Object.keys(settings.enabled),
      ...Object.keys(settings.projects[projectId] ?? {}),
    ]);
    const servers: Record<string, PluginMcpLaunch> = {};
    const taken = new Set([APP_MCP_SERVER_NAME, APP_MCP_DIRECT_SERVER_NAME]);
    for (const id of sortPluginKeys(ids)) {
      if (!pluginEnabled(settings, id, projectId) || !runnable(id, sources)) continue;
      const found = yield* installed(id);
      const declared = found?.manifest?.mcpServers;
      if (found === null || declared === undefined) continue;
      if (yield* needsSetup(found)) continue;
      const { values } = yield* settingValues(found, settings, true);
      const filesWritten = new Set<string>();
      for (const [name, server] of Object.entries(declared).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        // The first plugin by id keeps a name; the app's own servers keep theirs.
        if (taken.has(name)) continue;
        // A remote server is listed with its reason; only a program is launched for now.
        if (!("command" in server)) continue;
        const expanded = expandMcpServer(
          server,
          expandContext(found, (setting) =>
            setting.secret
              ? values.has(setting.name)
                ? secretFile(id, setting.name)
                : undefined
              : (values.get(setting.name) ?? setting.default),
          ),
        );
        if (expanded._tag !== "Stdio") continue;
        const command = yield* resolveCommand(found.folder, [
          pluginCommand(server.command),
          ...expanded.args,
        ]);
        if (command._tag === "NoPython") yield* Effect.logWarning(noPython(name), { plugin: id });
        if (command._tag !== "Program") continue;
        let written = true;
        for (const option of serverSettings(server)) {
          const secret = found.manifest?.settings.some(
            (setting) => setting.name === option && setting.secret,
          );
          if (secret !== true || filesWritten.has(option)) continue;
          const ok = yield* writeSecretFile(secretFile(id, option), values.get(option) ?? "").pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!ok) written = false;
          else filesWritten.add(option);
        }
        if (!written) continue;
        taken.add(name);
        servers[name] = { command: command.command, args: command.args, env: expanded.env };
      }
    }
    return servers;
  });

  const setSettings = Effect.fn("AgentdPlugins.setSettings")(function* (
    input: AgentdPluginSettingsInput,
  ) {
    const found = yield* installed(input.id);
    if (found === null) return yield* fail("unknown", `${input.id} is not installed.`);
    const declared = found.manifest?.settings ?? [];
    const plain: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(input.values)) {
      const setting = declared.find((known) => known.name === name);
      if (setting === undefined) {
        return yield* fail("invalid", `${input.id} has no setting ${name}.`);
      }
      if (!setting.secret) {
        plain[name] = value;
        continue;
      }
      const secret = pluginSecretName(input.id, name);
      yield* (
        value === null || value.length === 0
          ? secrets
              .remove(secret)
              .pipe(Effect.andThen(fs.remove(secretFile(input.id, name), { force: true })))
          : secrets.set(secret, new TextEncoder().encode(value))
      ).pipe(Effect.mapError(filesystem(`save ${setting.label}`)));
    }
    if (Object.keys(plain).length > 0) {
      const settings = yield* readSettings;
      yield* writeAtomic(
        settingsFile,
        encodeSettings(withPluginValues(settings, input.id, plain)),
      ).pipe(Effect.mapError(filesystem("save the plugin settings")));
    }
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  const listing = Effect.fn("AgentdPlugins.listing")(function* (all: Catalogs, projectId?: string) {
    const settings = yield* readSettings;
    const entries = new Map<string, PluginCatalog["plugins"][number]>();
    for (const served of all.served) {
      for (const entry of served.catalog?.plugins ?? []) {
        entries.set(pluginKey(served.origin, entry.id), entry);
      }
    }
    const ids = new Set([...entries.keys(), ...(yield* installedKeys(all.sources))]);
    const plugins = [];
    let beforeSend = false;
    for (const id of sortPluginKeys(ids)) {
      const entry = entries.get(id);
      const found = yield* installed(id);
      const parsedKey = parsePluginKey(id);
      if ((entry === undefined && found === null) || parsedKey === null) continue;
      const origin: AgentdPluginOrigin =
        parsedKey.origin.kind === "local"
          ? { kind: "local", path: found?.folder ?? "" }
          : parsedKey.origin;
      const enabled = pluginEnabled(settings, id, projectId);
      const hooks =
        found?.manifest?.hooks?.["before-send"] === undefined ? [] : ["before-send" as const];
      const setup = found === null ? undefined : yield* setupListing(found);
      const ready =
        found !== null &&
        hooks.length > 0 &&
        (yield* hookCommand({
          id,
          name: id,
          folder: found.folder,
          manifest: found.manifest,
          needsSetup: false,
        })) !== null;
      const setUp = setup === undefined || setup.status === "ready";
      const state =
        found === null
          ? "absent"
          : !enabled
            ? "off"
            : (ready || hooks.length === 0) && setUp
              ? "on"
              : "missing";
      if (enabled && ready) beforeSend = true;
      const projectEnabled =
        projectId === undefined ? undefined : settings.projects[projectId]?.[id];
      const contributed = found === null ? undefined : yield* contributions(found, settings);
      const sourceRemoved = found !== null && !isSource(parsedKey.origin, all.sources);
      plugins.push({
        id,
        origin,
        name: found?.manifest?.name ?? entry?.name ?? parsedKey.id,
        description: entry?.description ?? "",
        author: entry?.author ?? "",
        licence: entry?.licence ?? "",
        version: entry?.version ?? found?.record.version ?? "",
        ...(found === null ? {} : { installedVersion: found.record.version }),
        hooks,
        enabled: settings.enabled[id] === true,
        ...(projectEnabled === undefined ? {} : { projectEnabled }),
        state,
        ...(setup === undefined ? {} : { setup }),
        ...(contributed === undefined ? {} : contributed),
        ...(found?.problems === undefined ? {} : { problems: found.problems }),
        ...(sourceRemoved ? { sourceRemoved } : {}),
      } as const);
    }
    const sources = all.served.map((served): AgentdPluginSourceListing => ({
      repository: served.repository,
      official: served.origin.kind === "official",
      hasToken: served.hasToken,
      ...(served.connection ? { githubConnection: true as const } : {}),
      state: served.state,
    }));
    return {
      source: all.served[0]?.state ?? "none",
      sources,
      developerMode: all.sources.developerMode,
      plugins,
      beforeSend,
    } satisfies AgentdPlugins;
  });

  const list = Effect.fn("AgentdPlugins.list")(function* (input: AgentdPluginsListInput) {
    return yield* listing(yield* catalogs(), input.projectId);
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

  const notRunning = Effect.fn("AgentdPlugins.notRunning")(function* (id: string) {
    if ((yield* Ref.get(running)).has(id)) {
      return yield* fail("setup", `${id} is being set up. Wait for setup to finish.`);
    }
  });

  const install = Effect.fn("AgentdPlugins.install")(function* (input: AgentdPluginInput) {
    yield* notRunning(input.id);
    const key = parsePluginKey(input.id);
    if (key === null) return yield* fail("unknown", `${input.id} is not in a catalogue.`);
    if (key.origin.kind === "local") {
      return yield* fail(
        "invalid",
        "A local plugin is read from its folder; nothing is installed.",
      );
    }
    const all = yield* catalogs();
    const origin = key.origin;
    const served = all.served.find((candidate) => sameOrigin(candidate.origin, origin));
    if (served === undefined) {
      return yield* fail("unknown", `${input.id}'s catalogue is no longer a source.`);
    }
    const entry = served.catalog?.plugins.find((plugin) => plugin.id === key.id);
    if (entry === undefined) return yield* fail("unknown", `${key.id} is not in the catalogue.`);
    if (!validPluginVersion(entry.version)) {
      return yield* fail("unsafe", `${entry.version} is not a safe version name.`);
    }
    const repository = githubRepository(entry.source.url);
    if (repository === null) {
      return yield* fail("download", `${entry.source.url} is not a GitHub repository.`);
    }
    // A catalogue a person added installs only from its own repository, the one its token is for.
    if (origin.kind === "github" && repository.toLowerCase() !== origin.repository) {
      return yield* fail(
        "invalid",
        `${key.id} is pinned in ${repository}, not in ${origin.repository}; a catalogue you added installs only from its own repository.`,
      );
    }
    const pinned = {
      repository,
      commit: entry.source.sha,
      path: entry.source.path,
      notices: entry.source.notices,
    };
    const auth: SourceAuth =
      origin.kind === "github"
        ? yield* sourceAuth(origin.repository, all.sources)
        : { kind: "anonymous" };
    const token = auth.kind === "token" ? auth.token : undefined;
    const connected =
      origin.kind === "github" && auth.kind === "connection"
        ? yield* connectionToken(origin.repository)
        : undefined;
    if (auth.kind === "connection" && connected === undefined) {
      return yield* fail("download", NO_CONNECTION_MESSAGE);
    }
    const credential = token ?? connected;
    const files = yield* downloadPinned(
      pinned,
      PLUGIN_LAYOUT,
      credential === undefined ? undefined : tokenFetch(repository, credential),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(
        (error) =>
          new AgentdPluginError({
            reason: error.reason === "download" ? "download" : "unsafe",
            message: error.message,
          }),
      ),
    );
    const fileText = (target: string) => {
      const file = files.find((candidate) => candidate.target === target);
      return file === undefined ? undefined : new TextDecoder().decode(file.bytes);
    };
    const read = parsePluginFiles({
      plugin: fileText(CLAUDE_PLUGIN_FILE),
      mcp: fileText(CLAUDE_MCP_FILE),
      sidecar: fileText(PLUGIN_MANIFEST_FILE),
    });
    const manifest = read._tag === "Valid" ? read.plugin : null;
    if (manifest === null || manifest.id !== entry.id || manifest.version !== entry.version) {
      return yield* fail(
        "invalid",
        [
          `The plugin at commit ${entry.source.sha} does not describe ${entry.id} ${entry.version}.`,
          ...(read._tag === "Invalid" ? read.reasons : []),
        ].join("\n"),
      );
    }
    const before = yield* installed(input.id);
    const pluginFolder = path.join(cacheBase, sourceFolder(origin), input.id);
    const folder = path.join(pluginFolder, entry.version);
    const staging = path.join(pluginFolder, `.${entry.version}.staging-${stagingSuffix()}`);
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
        // Git's mode is kept, and a hook, setup or server that is a file of the plugin is run.
        if (
          file.executable ||
          [
            manifest.hooks?.["before-send"]?.command[0],
            manifest.setup?.command[0],
            ...Object.values(manifest.mcpServers).map((server) =>
              "command" in server ? pluginCommand(server.command) : undefined,
            ),
          ].some((first) => first?.replace(/^\.\//, "") === file.target)
        ) {
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
    return yield* listing(all);
  }, lock.withPermits(1));

  const remove = Effect.fn("AgentdPlugins.remove")(function* (input: AgentdPluginRemoveInput) {
    const found = yield* installed(input.id);
    if (found === null) return yield* fail("unknown", `${input.id} is not installed.`);
    yield* notRunning(input.id);
    if (found.origin.kind === "local") {
      // The folder is the developer's: only the app's note of it goes.
      const sources = yield* readSources;
      yield* writeSources({
        ...sources,
        local: sources.local.filter((local) => local.id !== found.record.id),
      });
    } else yield* removeInstall(found);
    yield* fs.remove(setupFile(input.id), { force: true }).pipe(Effect.ignore);
    for (const setting of found.manifest?.settings ?? []) {
      if (setting.secret) {
        yield* secrets.remove(pluginSecretName(input.id, setting.name)).pipe(Effect.ignore);
      }
    }
    yield* fs
      .remove(path.join(secretFilesRoot, input.id), { recursive: true, force: true })
      .pipe(Effect.ignore);
    if (input.deleteData === true) {
      // installed() parsed the key: it is one path segment under data/.
      const data = path.join(dataRoot, input.id);
      yield* fs
        .remove(data, { recursive: true, force: true })
        .pipe(Effect.mapError(filesystem(`remove ${data}`)));
    }
    const settings = yield* readSettings;
    yield* writeAtomic(settingsFile, encodeSettings(withoutPlugin(settings, input.id))).pipe(
      Effect.mapError(filesystem("save the plugin settings")),
    );
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  const setEnabled = Effect.fn("AgentdPlugins.setEnabled")(function* (
    input: AgentdPluginEnableInput,
  ) {
    const found = input.enabled === null ? null : yield* installed(input.id);
    if (input.enabled !== null && found === null) {
      return yield* fail("unknown", `${input.id} is not installed.`);
    }
    if (input.enabled === true && found !== null && (yield* needsSetup(found))) {
      return yield* fail(
        "setup",
        `${found.manifest?.name ?? input.id} needs setup before it can be turned on.`,
      );
    }
    if (input.enabled === null && input.projectId === undefined) {
      return yield* fail("invalid", "Only a project's setting can be cleared.");
    }
    const settings = yield* readSettings;
    yield* writeAtomic(
      settingsFile,
      encodeSettings(withPluginEnabled(settings, input.id, input.enabled, input.projectId)),
    ).pipe(Effect.mapError(filesystem("save the plugin settings")));
    return yield* listing(yield* catalogs(), input.projectId);
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
    files: ReadonlyArray<HookUnshownAttachment>,
    map: AgentdPlaceholderMap,
  ) {
    const fix = "Install it again or turn it off on the LibraOS Engine page.";
    if (hook.needsSetup) {
      return yield* blocked(
        `${hook.name} is turned on but not set up, so the message was not sent. Set it up in Settings, Plugins.`,
      );
    }
    const command = yield* hookCommand(hook);
    if (command === null) {
      return yield* blocked(`${hook.name} is turned on but its hook cannot be found. ${fix}`);
    }
    // A hook that does not read files sees only their names, as before files could be replaced.
    const readsFiles = command.declared.attachmentFiles === true;
    const unshown = files
      .filter((file) => !content.attachments.some((shown) => shown.id === file.id))
      .map((file) => (readsFiles ? file : { id: file.id, name: file.name }));
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
    const decision = parseHookOutput(output.stdout, content, map, readsFiles ? unshown : []);
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

  const finishSetup = Effect.fn("AgentdPlugins.finishSetup")(function* (
    found: Installed,
    reason: string | null,
  ) {
    const record: PluginSetupRecord = {
      schemaVersion: 1,
      id: found.key,
      version: found.record.version,
      commit: found.record.commit,
      status: reason === null ? "ready" : "failed",
      finishedAt: iso(yield* Clock.currentTimeMillis),
      ...(reason === null ? {} : { reason }),
    };
    yield* writeAtomic(setupFile(found.key), encodeSetup(record)).pipe(Effect.ignore);
  });

  /** Runs setup to its end and records how it ended; output is kept only as the last line. */
  const runSetup = Effect.fn("AgentdPlugins.runSetup")(function* (
    found: Installed,
    entry: RunningSetup,
  ) {
    const id = found.key;
    const declared = found.manifest!.setup!;
    const name = found.manifest?.name ?? id;
    const command = yield* resolveCommand(found.folder, declared.command);
    if (command._tag === "NoPython") {
      return yield* finishSetup(
        found,
        `${name}'s setup is a Python script and Python 3 was not found. ${PYTHON_INSTALL}, then set it up again.`,
      );
    }
    if (command._tag === "NotFound") {
      return yield* finishSetup(found, `${name}'s setup command cannot be found.`);
    }
    const enginePath = yield* engine;
    let pending = "";
    const decoder = new TextDecoder();
    const progress = (chunk: Uint8Array) => {
      pending = (pending + decoder.decode(chunk, { stream: true })).slice(-4096);
      const line = lastLine(pending);
      if (line === null) return;
      entry.progress = line;
    };
    // Like a hook: in the plugin's folder with the server's environment, but nothing on stdin.
    const output = yield* runner
      .run({
        command: command.command,
        args: command.args,
        cwd: found.folder,
        // So a setup finds the engine whatever its name on PATH, or when it is not on PATH.
        ...(enginePath === null ? {} : { env: { [LIBRAOS_ENGINE_ENV]: enginePath } }),
        // Empty and closed at once, so a setup that reads stdin ends instead of waiting.
        stdin: "",
        timeout: Duration.minutes(SETUP_TIMEOUT_MINUTES),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: SETUP_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        onStdoutChunk: progress,
      })
      .pipe(Effect.result);
    if (output._tag === "Failure") {
      return yield* finishSetup(
        found,
        output.failure._tag === "ProcessSpawnError"
          ? `${name}'s setup could not be started.`
          : `${name}'s setup failed.`,
      );
    }
    const result = output.success;
    if (result.timedOut) {
      return yield* finishSetup(
        found,
        `${name}'s setup did not finish within ${String(SETUP_TIMEOUT_MINUTES)} minutes. Set it up again to continue.`,
      );
    }
    if (result.code !== 0) {
      const said = lastLine(result.stderr) ?? lastLine(result.stdout);
      return yield* finishSetup(
        found,
        `${name}'s setup failed (exit ${String(result.code)})${said === null ? "." : `: ${said}`}`,
      );
    }
    yield* finishSetup(found, null);
  });

  const setup = Effect.fn("AgentdPlugins.setup")(function* (input: AgentdPluginInput) {
    const found = yield* installed(input.id);
    if (found === null) return yield* fail("unknown", `${input.id} is not installed.`);
    if (found.manifest?.setup === undefined) {
      return yield* fail("invalid", `${input.id} has no setup step.`);
    }
    yield* notRunning(input.id);
    const entry: RunningSetup = { progress: null, done: yield* Deferred.make<void>() };
    const done = entry.done;
    yield* Ref.update(running, (all) => new Map(all).set(input.id, entry));
    yield* fs.remove(setupFile(input.id), { force: true }).pipe(Effect.ignore);
    // Outlives the request: a closed tab or a dropped phone connection does not stop a download.
    yield* runSetup(found, entry).pipe(
      Effect.ensuring(
        Ref.update(running, (all) => {
          const next = new Map(all);
          next.delete(input.id);
          return next;
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      ),
      Effect.forkIn(scope),
    );
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  const setupDone = (id: string) =>
    Ref.get(running).pipe(
      Effect.flatMap((all) => {
        const now = all.get(id);
        return now === undefined ? Effect.void : Deferred.await(now.done);
      }),
    );

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
      .map((attachment): HookUnshownAttachment => {
        const file = attachmentFile(request.threadId, attachment);
        return {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          ...(file === null ? {} : { path: file }),
        };
      });
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
      replacedFiles: unshown
        .filter((file) => content.attachments.some((attachment) => attachment.id === file.id))
        .map((file) => ({ id: file.id, name: file.name })),
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

  /**
   * A replaced file's text as a new pending upload, which the send claims as any other; the file
   * itself, and text extracted from it beside it, are deleted when they were a pending upload.
   */
  const replaceFile = Effect.fn("AgentdPlugins.replaceFile")(function* (
    held: HeldReview,
    attachment: ChatAttachment,
    name: string,
    text: string,
  ) {
    const bytes = new TextEncoder().encode(text);
    const id = createPendingAttachmentId(".txt");
    const target = resolveAttachmentRelativePath({
      attachmentsDir: config.attachmentsDir,
      relativePath: `${id}.txt`,
    });
    if (target === null || bytes.byteLength === 0) {
      return yield* blocked(
        `The text of ${attachment.name} is empty, so the message was not sent.`,
      );
    }
    yield* fs
      .writeFile(target, bytes, { flag: "wx" })
      .pipe(Effect.mapError(() => blocked(`The text of ${attachment.name} could not be saved.`)));
    const claim = planAttachmentClaim({
      attachmentsDir: config.attachmentsDir,
      threadId: held.review.threadId,
      attachmentId: attachment.id,
    });
    if (claim.ok) {
      yield* fs.remove(claim.currentPath, { force: true }).pipe(Effect.ignore);
      yield* fs.remove(`${claim.currentPath}.txt`, { force: true }).pipe(Effect.ignore);
    }
    return {
      type: "file",
      id: ChatAttachmentId.make(id),
      name,
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
    } satisfies ChatAttachment;
  });

  /**
   * Writes the confirmed text over a held upload, and puts a replaced file's text in its place;
   * only uploads not yet sent can change. A replaced file never goes on, confirmed or not.
   */
  const applyAttachments = Effect.fn("AgentdPlugins.applyAttachments")(function* (
    held: HeldReview,
    confirmed: ReadonlyArray<AgentdBeforeSendAttachment>,
  ) {
    const byId = new Map(confirmed.map((attachment) => [attachment.id, attachment.text]));
    const shown = new Map(held.review.original.attachments.map((a) => [a.id, a.text]));
    const replaced = new Set(held.review.replacedFiles.map((file) => file.id));
    const result: ChatAttachment[] = [];
    for (const attachment of held.attachments) {
      if (replaced.has(attachment.id)) {
        const proposed = held.review.proposed.attachments.find((a) => a.id === attachment.id);
        if (proposed === undefined) return yield* blocked("This review is damaged. Send again.");
        const text = byId.get(attachment.id) ?? proposed.text;
        result.push(yield* replaceFile(held, attachment, proposed.name, text));
        continue;
      }
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

  /** A plugin link's plugin in the catalogue just read, pinned in the repository it names. */
  const linkedKey = Effect.fn("AgentdPlugins.linkedKey")(function* (
    origin: PluginOrigin,
    repository: string,
    catalog: PluginCatalog | undefined,
    tree: string,
  ) {
    const found = linkedPlugin(catalog, repository, tree);
    if (found._tag === "Missing") {
      return yield* fail(
        "unknown",
        `The catalogue of ${repository} has no plugin in the folder that link names (${tree}).`,
      );
    }
    if (found._tag === "Elsewhere") {
      return yield* fail(
        "invalid",
        `${found.id} is pinned in ${found.repository}, not in ${repository}; a link installs only from the repository it names.`,
      );
    }
    return pluginKey(origin, found.id);
  });

  const addSource = Effect.fn("AgentdPlugins.addSource")(function* (
    input: AgentdPluginSourceInput,
  ) {
    const link = parseSourceLink(input.repository);
    if (link === null) {
      return yield* fail(
        "invalid",
        `${input.repository} is not a GitHub repository or a link into one (github.com/owner/repo).`,
      );
    }
    const repository = link.repository;
    if (repository === OFFICIAL_REPOSITORY) {
      if (link.tree === undefined) {
        return yield* fail("invalid", "The official catalogue is always listed.");
      }
      const all = yield* catalogs();
      const key = yield* linkedKey(
        { kind: "official" },
        repository,
        all.served[0]?.catalog,
        link.tree,
      );
      return { ...(yield* listing(all)), linked: key };
    }
    const given = input.token?.trim() ?? "";
    if (given.length > 0 && !TOKEN.test(given)) {
      return yield* fail("invalid", "That token has spaces or characters a token cannot have.");
    }
    const sources = yield* readSources;
    const known = sources.github.find((candidate) => candidate.repository === repository);
    const auth: SourceAuth =
      given.length > 0
        ? { kind: "token", token: given }
        : input.useGitHubConnection === true
          ? { kind: "connection" }
          : yield* sourceAuth(repository, sources);
    const forget =
      known === undefined
        ? fs.remove(sourceCacheFile(repository), { force: true }).pipe(Effect.ignore)
        : Effect.void;
    // Read before saving, so a wrong name or token is said now rather than as an empty list.
    const read = yield* githubCatalog(repository, auth, true);
    if (read.state !== "fetched") {
      yield* forget;
      if (read.failure === NO_CONNECTION) {
        return yield* new AgentdPluginError({
          reason: "githubConnection",
          message: NO_CONNECTION_MESSAGE,
          githubConnection: { repository, connected: false },
        });
      }
      // GitHub answers 404 for a private repository read anonymously: offer the connection.
      if (auth.kind === "anonymous" && read.failure?.endsWith("HTTP 404") === true) {
        return yield* new AgentdPluginError({
          reason: "githubConnection",
          message: `${repository} could not be read without signing in to GitHub; it may be private.`,
          githubConnection: { repository, connected: true },
        });
      }
      return yield* fail(
        "download",
        auth.kind === "connection"
          ? `The catalogue of ${repository} could not be read with your GitHub connection (${read.failure ?? "no catalogue"}). Check that your account or the GitHub App can read it, or give a read-only token.`
          : `The catalogue of ${repository} could not be read (${read.failure ?? "no catalogue"}). A private repository needs a token with Contents: read.`,
      );
    }
    // A plugin link that names no plugin of this catalogue adds nothing.
    const origin: PluginOrigin = { kind: "github", repository };
    const linked =
      link.tree === undefined
        ? undefined
        : yield* linkedKey(origin, repository, read.catalog, link.tree).pipe(
            Effect.tapError(() => forget),
          );
    if (auth.kind === "token" && given.length > 0) {
      yield* secrets
        .set(sourceTokenName(repository), new TextEncoder().encode(given))
        .pipe(Effect.mapError(filesystem("save the token")));
    }
    if (auth.kind === "connection" && input.useGitHubConnection === true) {
      // One way of reading a source: the connection the person chose replaces a kept token.
      yield* secrets
        .remove(sourceTokenName(repository))
        .pipe(Effect.mapError(filesystem(`remove the token of ${repository}`)));
    }
    const entry =
      auth.kind === "connection" ? { repository, githubConnection: true } : { repository };
    if (known === undefined || (known.githubConnection === true) !== (auth.kind === "connection")) {
      yield* writeSources({
        ...sources,
        github:
          known === undefined
            ? [...sources.github, entry]
            : sources.github.map((candidate) => (candidate === known ? entry : candidate)),
      });
    }
    const listed = yield* listing(yield* catalogs());
    return linked === undefined ? listed : { ...listed, linked };
  }, lock.withPermits(1));

  const removeSource = Effect.fn("AgentdPlugins.removeSource")(function* (
    input: AgentdPluginSourceRemoveInput,
  ) {
    const repository = sourceRepository(input.repository);
    if (repository === OFFICIAL_REPOSITORY) {
      return yield* fail("invalid", "The official catalogue cannot be removed.");
    }
    const sources = yield* readSources;
    if (repository === null || !sources.github.some((known) => known.repository === repository)) {
      return yield* fail("unknown", `${input.repository} is not a catalogue source.`);
    }
    // The token goes first: a source is never dropped with its token left behind.
    yield* secrets
      .remove(sourceTokenName(repository))
      .pipe(Effect.mapError(filesystem(`remove the token of ${repository}`)));
    yield* writeSources({
      ...sources,
      github: sources.github.filter((known) => known.repository !== repository),
    });
    yield* fs.remove(sourceCacheFile(repository), { force: true }).pipe(Effect.ignore);
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  const setDeveloperMode = Effect.fn("AgentdPlugins.setDeveloperMode")(function* (
    input: AgentdPluginDeveloperModeInput,
  ) {
    const sources = yield* readSources;
    yield* writeSources({ ...sources, developerMode: input.enabled });
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  const addLocal = Effect.fn("AgentdPlugins.addLocal")(function* (input: AgentdPluginLocalInput) {
    const sources = yield* readSources;
    if (!sources.developerMode) {
      return yield* fail("invalid", "Turn on developer mode to add a plugin from a folder.");
    }
    const given = input.path.trim();
    if (!path.isAbsolute(given)) return yield* fail("invalid", "Give the folder's full path.");
    const refused = (message: string) => () =>
      new AgentdPluginError({ reason: "invalid", message });
    const folder = yield* fs
      .realPath(given)
      .pipe(Effect.mapError(refused(`${given} cannot be read.`)));
    const parsed = yield* readDefinition(folder);
    if (parsed._tag === "Invalid") {
      return yield* fail(
        "invalid",
        [`The plugin in ${folder} is refused:`, ...parsed.reasons].join("\n"),
      );
    }
    const id = parsed.plugin.id;
    yield* writeSources({
      ...sources,
      local: [...sources.local.filter((local) => local.id !== id), { id, path: folder }],
    });
    return yield* listing(yield* catalogs());
  }, lock.withPermits(1));

  return AgentdPluginsService.of({
    addSource,
    removeSource,
    setDeveloperMode,
    addLocal,
    list,
    install,
    remove,
    setup,
    setupDone,
    setSettings,
    mcpServers,
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
export const layerLive = layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(AgentdGitHubConnection.layer),
);
