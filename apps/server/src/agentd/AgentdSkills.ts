import {
  AgentdSkillError,
  type AgentdSkillAgent,
  type AgentdSkillAgentState,
  type AgentdSkillErrorReason,
  type AgentdSkillInput,
  type AgentdSkillInstallInput,
  type AgentdSkills,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  CATALOG_MAX_BYTES,
  CATALOG_URL,
  CatalogCache,
  MANIFEST_FILE,
  Manifest,
  type Catalog,
  type CatalogEntry,
  type HostPaths,
  type PinnedSource,
  decodeCatalogCache,
  decodeGitTree,
  decodeManifest,
  fetchDue,
  gitBlobId,
  githubRepository,
  parseCatalog,
  planFiles,
  resolveInside,
  skillsDirectory,
  stagingSuffix,
  urlPath,
  validSkillName,
} from "./skillCatalog.ts";

// Skills from the catalogue, installed into Claude Code's and Codex's user Skills folders. The
// catalogue is fetched at most once a day and cached; installs fetch the pinned commit's files
// into memory, verify each against git's id, and only then write a staging folder that is renamed
// into place, so a failure leaves the Skills folder as it was.

export class AgentdSkillsService extends Context.Service<
  AgentdSkillsService,
  {
    readonly list: Effect.Effect<AgentdSkills, AgentdSkillError>;
    readonly install: (
      input: AgentdSkillInstallInput,
    ) => Effect.Effect<AgentdSkills, AgentdSkillError>;
    readonly remove: (input: AgentdSkillInput) => Effect.Effect<AgentdSkills, AgentdSkillError>;
  }
>()("t3/agentd/AgentdSkills/AgentdSkillsService") {}

const AGENTS: ReadonlyArray<AgentdSkillAgent> = ["claude", "codex"];
const REQUEST_TIMEOUT = Duration.seconds(20);

const fail = (reason: AgentdSkillErrorReason, message: string) =>
  Effect.fail(new AgentdSkillError({ reason, message }));

const encodeCache = Schema.encodeSync(Schema.fromJsonString(CatalogCache));
const isSkillError = Schema.is(AgentdSkillError);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));

type Served = Omit<AgentdSkills, "skills" | "groups"> & { readonly catalog: Catalog | undefined };

const supports = (entry: CatalogEntry, agent: AgentdSkillAgent) => entry.agents.includes(agent);

/** A URL's body, or why it could not be had. */
export const getUrlBytes = Effect.fn("AgentdSkills.get")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(HttpClientRequest.get(url)).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(() => `${url}: the request failed`),
  );
  if (response.status !== 200) return yield* Effect.fail(`${url}: HTTP ${response.status}`);
  const buffer = yield* response.arrayBuffer.pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(() => `${url}: the response could not be read`),
  );
  return new Uint8Array(buffer);
});

/**
 * Every file of a pinned folder, fetched and checked against the commit's ids; nothing is written.
 * Skills and plugins both install through this.
 */
export const downloadPinned = Effect.fn("AgentdSkills.download")(function* (
  entry: PinnedSource,
  layout?: Parameters<typeof planFiles>[2],
) {
  const treeUrl = `https://api.github.com/repos/${urlPath(entry.repository)}/git/trees/${entry.commit}?recursive=1`;
  const treeBytes = yield* getUrlBytes(treeUrl).pipe(
    Effect.catch((detail) =>
      fail("download", `Commit ${entry.commit} could not be read: ${detail}`),
    ),
  );
  const tree = decodeGitTree(new TextDecoder().decode(treeBytes));
  if (Option.isNone(tree))
    return yield* fail("download", `Commit ${entry.commit} could not be read.`);
  const plan = planFiles(entry, tree.value, layout);
  if (plan._tag === "Refused") return yield* fail(plan.reason, plan.detail);
  const files: Array<{ readonly target: string; readonly bytes: Uint8Array }> = [];
  for (const file of plan.files) {
    const url = `https://raw.githubusercontent.com/${urlPath(entry.repository, entry.commit, file.source)}`;
    const bytes = yield* getUrlBytes(url).pipe(Effect.catch((detail) => fail("download", detail)));
    if (gitBlobId(bytes) !== file.sha) {
      return yield* fail("download", `${file.source} does not match commit ${entry.commit}.`);
    }
    files.push({ target: file.target, bytes });
  }
  return files;
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const host: HostPaths = {
    platform: yield* HostProcess.Platform,
    home: yield* HostProcess.HomeDirectory,
    env: yield* HostProcess.Environment,
  };
  const cacheFile = path.join(config.stateDir, "skills", "catalog.json");
  const lock = yield* Semaphore.make(1);

  const deniedBy = () => ManagedPolicy.deniedBy(policy, "skillCatalog");

  const getBytes = (url: string) =>
    getUrlBytes(url).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

  const readCache = fs.readFileString(cacheFile).pipe(
    Effect.map((text) => Option.getOrNull(decodeCatalogCache(text))),
    Effect.orElseSucceed(() => null),
  );

  const writeCache = (cache: CatalogCache) =>
    fs
      .makeDirectory(path.dirname(cacheFile), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(`${cacheFile}.tmp`, encodeCache(cache))),
        Effect.andThen(fs.rename(`${cacheFile}.tmp`, cacheFile)),
        Effect.ignore,
      );

  const fetchCatalog = getBytes(CATALOG_URL).pipe(
    Effect.flatMap((bytes) => {
      if (bytes.byteLength > CATALOG_MAX_BYTES) return Effect.fail("the catalogue is too large");
      const catalog = parseCatalog(new TextDecoder().decode(bytes));
      return catalog === null ? Effect.fail("the catalogue is not valid") : Effect.succeed(catalog);
    }),
    Effect.option,
  );

  const catalog = Effect.fn("AgentdSkills.catalog")(function* () {
    const organization = deniedBy();
    if (organization !== undefined) {
      return { source: "off", organization, catalog: undefined } satisfies Served;
    }
    const now = yield* Clock.currentTimeMillis;
    const cache = yield* readCache;
    const cached: Served =
      cache?.catalog === undefined
        ? { source: "none", catalog: undefined }
        : {
            source: "cache",
            catalog: cache.catalog,
            ...(cache.fetchedAt === undefined ? {} : { fetchedAt: cache.fetchedAt }),
          };
    if (!fetchDue(cache, now)) return cached;
    const attemptedAt = iso(now);
    const fetched = yield* fetchCatalog;
    if (Option.isNone(fetched)) {
      yield* writeCache({
        attemptedAt,
        ...(cache?.fetchedAt === undefined ? {} : { fetchedAt: cache.fetchedAt }),
        ...(cache?.catalog === undefined ? {} : { catalog: cache.catalog }),
      });
      return cached;
    }
    yield* writeCache({ attemptedAt, fetchedAt: attemptedAt, catalog: fetched.value });
    return { source: "fetched", fetchedAt: attemptedAt, catalog: fetched.value } satisfies Served;
  });

  const isLink = (file: string) =>
    fs.readLink(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const readManifest = (folder: string) =>
    fs.readFileString(path.join(folder, MANIFEST_FILE)).pipe(
      Effect.map((text) => Option.getOrNull(decodeManifest(text))),
      Effect.orElseSucceed(() => null),
    );

  /** What is at `folder` now: our install (with its manifest), a folder put there by hand, or nothing. */
  const inspect = Effect.fn("AgentdSkills.inspect")(function* (folder: string, name: string) {
    if (yield* isLink(folder)) return { state: "manual" as const };
    const exists = yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { state: "absent" as const };
    const manifest = yield* readManifest(folder);
    return manifest !== null && manifest.name === name
      ? { state: "managed" as const, manifest }
      : { state: "manual" as const };
  });

  const folderFor = (agent: AgentdSkillAgent, name: string) => {
    const root = skillsDirectory(agent, host);
    const folder = validSkillName(name) ? resolveInside(host.platform, root, name) : null;
    return folder === null ? null : { root, folder };
  };

  const listing = Effect.fn("AgentdSkills.listing")(function* (served: Served) {
    const skills = [];
    for (const entry of served.catalog?.skills ?? []) {
      const agents: AgentdSkillAgentState[] = [];
      for (const agent of AGENTS.filter((agent) => supports(entry, agent))) {
        const found = folderFor(agent, entry.id);
        const seen =
          found === null ? { state: "absent" as const } : yield* inspect(found.folder, entry.id);
        agents.push(
          seen.state === "managed"
            ? { agent, state: "managed", commit: seen.manifest.commit }
            : { agent, state: seen.state },
        );
      }
      const { id, name, description, group, author, licence, reviewedAt, source } = entry;
      skills.push({ id, name, description, group, author, licence, reviewedAt, source, agents });
    }
    const { catalog: _catalog, ...rest } = served;
    return { ...rest, groups: served.catalog?.groups ?? [], skills } satisfies AgentdSkills;
  });

  const download = (entry: PinnedSource) =>
    downloadPinned(entry).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const filesystem = (what: string) => () =>
    new AgentdSkillError({ reason: "filesystem", message: `Could not ${what}.` });

  const install = Effect.fn("AgentdSkills.install")(function* (input: AgentdSkillInstallInput) {
    const organization = deniedBy();
    if (organization !== undefined) {
      return yield* fail("policy", `${organization}'s policy does not allow the Skills catalogue.`);
    }
    const served = yield* catalog();
    const entry = served.catalog?.skills.find((skill) => skill.id === input.id);
    if (entry === undefined) return yield* fail("unknown", `${input.id} is not in the catalogue.`);
    if (!supports(entry, input.agent)) {
      return yield* fail(
        "unsupported",
        `${entry.name} is not listed for ${input.agent === "claude" ? "Claude Code" : "Codex"}.`,
      );
    }
    const repository = githubRepository(entry.source.url);
    if (repository === null) {
      return yield* fail("download", `${entry.source.url} is not a GitHub repository.`);
    }
    const pinned: PinnedSource = {
      repository,
      commit: entry.source.sha,
      path: entry.source.path,
      notices: entry.source.notices,
    };
    const found = folderFor(input.agent, entry.id);
    if (found === null) return yield* fail("unsafe", `${entry.id} is not a safe folder name.`);
    const { root, folder } = found;
    const before = yield* inspect(folder, entry.id);
    if (before.state === "manual" && input.replace !== true) {
      return yield* fail(
        "conflict",
        `${folder} was not installed from the catalogue; replace it to install.`,
      );
    }
    if (before.state === "managed" && input.replace !== true) {
      // An update swaps the whole folder, so files someone added there would go with it.
      const ours = new Set([MANIFEST_FILE, ...before.manifest.files]);
      for (const file of before.manifest.files) {
        for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
          ours.add(file.slice(0, at));
        }
      }
      const present = yield* fs
        .readDirectory(folder, { recursive: true })
        .pipe(Effect.mapError(filesystem(`read ${folder}`)));
      const added = present
        .map((entry) => entry.split(path.sep).join("/"))
        .filter((entry) => !ours.has(entry));
      if (added.length > 0) {
        return yield* fail(
          "conflict",
          `${folder} holds files the catalogue did not install (${added[0]}); replace it to update.`,
        );
      }
    }

    const files = yield* download(pinned);

    const suffix = stagingSuffix();
    const staging = path.join(root, `.${entry.id}.agentd-staging-${suffix}`);
    const aside = path.join(root, `.${entry.id}.agentd-old-${suffix}`);
    const manifest: Manifest = {
      schemaVersion: 1,
      name: entry.id,
      repository: pinned.repository,
      commit: pinned.commit,
      path: pinned.path,
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
      }
      yield* fs.writeFileString(path.join(staging, MANIFEST_FILE), encodeManifest(manifest));
    });
    const moveIn = Effect.gen(function* () {
      if (before.state === "absent") return yield* fs.rename(staging, folder);
      yield* fs.rename(folder, aside);
      yield* fs
        .rename(staging, folder)
        .pipe(Effect.tapError(() => fs.rename(aside, folder).pipe(Effect.ignore)));
      yield* fs.remove(aside, { recursive: true }).pipe(Effect.ignore);
    });
    yield* writeStaging.pipe(
      Effect.andThen(moveIn),
      Effect.mapError((error) => (isSkillError(error) ? error : filesystem(`write ${folder}`)())),
      Effect.tapError(() =>
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    return yield* listing(served);
  }, lock.withPermits(1));

  const remove = Effect.fn("AgentdSkills.remove")(function* (input: AgentdSkillInput) {
    const found = folderFor(input.agent, input.id);
    if (found === null) return yield* fail("unsafe", `${input.id} is not a safe folder name.`);
    const { folder } = found;
    const seen = yield* inspect(folder, input.id);
    if (seen.state !== "managed") {
      return yield* fail(
        seen.state === "absent" ? "unknown" : "conflict",
        seen.state === "absent"
          ? `${input.id} is not installed.`
          : `${folder} was not installed from the catalogue, so it is left alone.`,
      );
    }
    const real = yield* fs.realPath(folder).pipe(Effect.mapError(filesystem(`read ${folder}`)));
    const parents = new Set<string>();
    for (const file of seen.manifest.files) {
      const target = resolveInside(host.platform, folder, file);
      if (target === null) continue;
      // A folder inside replaced by a link could lead outside; only delete what resolves inside.
      const resolved = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => null));
      const inside = resolved === null ? null : path.relative(real, resolved);
      if (inside === null || inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
        continue;
      }
      yield* fs.remove(target).pipe(Effect.mapError(filesystem(`remove ${target}`)));
      for (let dir = path.dirname(target); dir.length > folder.length; dir = path.dirname(dir))
        parents.add(dir);
    }
    yield* fs
      .remove(path.join(folder, MANIFEST_FILE))
      .pipe(Effect.mapError(filesystem(`remove ${folder}`)));
    // Deepest first; a folder still holding something not ours stays.
    for (const dir of [...parents, folder].toSorted((a, b) => b.length - a.length)) {
      const left = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => ["?"]));
      // Checked empty just above; rm needs recursive to remove a directory at all.
      if (left.length === 0) yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
    }
    return yield* listing(yield* catalog());
  }, lock.withPermits(1));

  return AgentdSkillsService.of({
    list: catalog().pipe(Effect.flatMap(listing), lock.withPermits(1)),
    install,
    remove,
  });
});

export const layer = Layer.effect(AgentdSkillsService, make);
