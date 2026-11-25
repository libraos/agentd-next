// @effect-diagnostics nodeBuiltinImport:off - paths for another OS, and git's SHA-1 blob ids.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { AgentdSkillAgent, AgentdWorkerTool } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// The Skills catalogue's pure parts: its format, the paths it may write, where each agent keeps
// user Skills, and the manifest that marks a folder as installed from the catalogue.

export const CATALOG_URL = "https://raw.githubusercontent.com/libraos/skills/main/catalog.json";
export const CATALOG_MAX_BYTES = 256 * 1024;
export const MANIFEST_FILE = ".agentd-skill.json";
const SKILL_LIMITS = { files: 500, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 };

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const validSkillName = (name: string) => SKILL_NAME.test(name);
/** A random part for staging and set-aside folder names. */
export const stagingSuffix = () => NodeCrypto.randomBytes(6).toString("hex");
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
// Names Windows will not create as files, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A repository-relative path that is safe to write under a folder on every OS: forward slashes,
 * no empty, `.` or `..` segment, no drive, colon, backslash or control character, no Windows
 * reserved name or trailing dot or space. Returns the segments, or null when unsafe.
 */
export function safeRelativePath(path: string): ReadonlyArray<string> | null {
  if (path.length === 0 || path.length > 400) return null;
  if (/[\\:*?"<>|\u0000-\u001f]/.test(path)) return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (/[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) return null;
  }
  return segments;
}

const SafePath = Schema.String.check(
  Schema.makeFilter((value: string) => safeRelativePath(value) !== null, {
    expected: "a safe relative path",
  }),
);

const GROUP_ID = /^[a-z0-9-]+$/;
const GITHUB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** `owner/repo` for a GitHub repository URL, which is all install can fetch from; else null. */
export function githubRepository(url: string): string | null {
  const match = GITHUB_URL.exec(url);
  if (match === null) return null;
  const repository = `${match[1]}/${match[2]}`;
  return REPOSITORY.test(repository) && !/^\.+$/.test(match[2] ?? "") ? repository : null;
}

export const CatalogSource = Schema.Struct({
  /** The Skill's git repository. */
  url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  /** The Skill's folder in the repository; its SKILL.md is at the folder's top. */
  path: SafePath,
  /** The reviewed commit; only this commit is installed. */
  sha: Schema.String.check(Schema.isPattern(COMMIT)),
  /** Licence and notice files elsewhere in the repository that apply to this Skill. */
  notices: Schema.optionalKey(Schema.Array(SafePath)),
});
export type CatalogSource = typeof CatalogSource.Type;

export const CatalogGroup = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GROUP_ID)),
  name: Schema.String,
});

export const CatalogEntry = Schema.Struct({
  /** Also the Skill's folder name in each agent's Skills folder. */
  id: Schema.String.check(Schema.isPattern(SKILL_NAME)),
  name: Schema.String,
  description: Schema.String.check(Schema.isMaxLength(500)),
  group: Schema.String,
  author: Schema.String,
  source: CatalogSource,
  licence: Schema.String,
  reviewedAt: Schema.String,
  /** Kept as strings so an agent this build does not know leaves the catalogue readable. */
  agents: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
export type CatalogEntry = typeof CatalogEntry.Type;

/** The format published at libraos/skills (`catalog.schema.json` there), plus `source.notices`. */
export const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  groups: Schema.Array(CatalogGroup),
  skills: Schema.Array(CatalogEntry),
});
export type Catalog = typeof Catalog.Type;

const decodeCatalogJson = Schema.decodeUnknownOption(Schema.fromJsonString(Catalog));

/**
 * The catalogue in `text`, or null when it does not decode, repeats a group or Skill id, or puts
 * a Skill in a group it does not define.
 */
export function parseCatalog(text: string): Catalog | null {
  const decoded = decodeCatalogJson(text);
  if (decoded._tag === "None") return null;
  const { groups, skills } = decoded.value;
  const groupIds = new Set(groups.map((group) => group.id));
  if (groupIds.size !== groups.length) return null;
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) return null;
  if (skills.some((skill) => !groupIds.has(skill.group))) return null;
  return decoded.value;
}

export const CatalogCache = Schema.Struct({
  /** The last request, successful or not; the next waits a day from it. */
  attemptedAt: Schema.String,
  fetchedAt: Schema.optionalKey(Schema.String),
  catalog: Schema.optionalKey(Catalog),
});
export type CatalogCache = typeof CatalogCache.Type;
export const decodeCatalogCache = Schema.decodeUnknownOption(Schema.fromJsonString(CatalogCache));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a request may be made now: none in the last day, successful or not. */
export function fetchDue(cache: Pick<CatalogCache, "attemptedAt"> | null, now: number): boolean {
  if (cache === null) return true;
  const last = Date.parse(cache.attemptedAt);
  // A time in the future (a clock moved back) counts as due rather than blocking for good.
  return !Number.isFinite(last) || now - last >= DAY_MS || now < last;
}

export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  repository: Schema.String,
  commit: Schema.String,
  path: Schema.String,
  installedAt: Schema.String,
  /** Every file this install wrote, relative to the Skill's folder, forward slashes. */
  files: Schema.Array(SafePath),
});
export type Manifest = typeof Manifest.Type;
export const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

export interface HostPaths {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The host OS's path functions, so Windows paths come out right when tests run elsewhere. */
const pathFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

/**
 * Where each agent reads user Skills: Claude Code `CLAUDE_CONFIG_DIR` or `~/.claude`, then
 * `skills`; Codex `~/.agents/skills`, as `install.sh` and agentd connect write them.
 */
export function skillsDirectory(agent: AgentdSkillAgent, host: HostPaths): string {
  const path = pathFor(host.platform);
  if (agent === "claude") {
    const configured = host.env["CLAUDE_CONFIG_DIR"]?.trim();
    return path.join(configured ? configured : path.join(host.home, ".claude"), "skills");
  }
  return path.join(host.home, ".agents", "skills");
}

/** The two Skills agentd's own install writes into each worker tool (`install.sh`, the desktop). */
export const AGENTD_SKILLS = ["agentd", "agentd-setup"] as const;

/** Where a worker tool finds agentd's Skills; opencode also reads Claude Code's and Codex's. */
export function workerSkillsDirectories(tool: AgentdWorkerTool, host: HostPaths): string[] {
  if (tool !== "opencode") return [skillsDirectory(tool, host)];
  const path = pathFor(host.platform);
  const config = host.env["XDG_CONFIG_HOME"]?.trim() || path.join(host.home, ".config");
  return [
    skillsDirectory("claude", host),
    skillsDirectory("codex", host),
    path.join(config, "opencode", "skills"),
  ];
}

/** `relative` (forward slashes) under `root` on the host OS; null when it would leave `root`. */
export function resolveInside(
  platform: NodeJS.Platform,
  root: string,
  relative: string,
): string | null {
  const segments = safeRelativePath(relative);
  if (segments === null) return null;
  const path = pathFor(platform);
  const target = path.resolve(root, ...segments);
  const back = path.relative(path.resolve(root), target);
  return back === "" || back.startsWith("..") || path.isAbsolute(back) ? null : target;
}

/** git's object id for a file's bytes, which the trees API lists for each file. */
export function gitBlobId(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

export interface TreeItem {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number | undefined;
}

export const GitTree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
      size: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export const decodeGitTree = Schema.decodeUnknownOption(Schema.fromJsonString(GitTree));

/** One file to fetch: where it is in the repository and where it goes in the Skill's folder. */
export interface PlannedFile {
  readonly source: string;
  readonly target: string;
  readonly sha: string;
}

export type Plan =
  | { readonly _tag: "Files"; readonly files: ReadonlyArray<PlannedFile> }
  | { readonly _tag: "Refused"; readonly reason: "unsafe" | "download"; readonly detail: string };

const refused = (reason: "unsafe" | "download", detail: string): Plan => ({
  _tag: "Refused",
  reason,
  detail,
});

/** What install fetches: one folder of a GitHub repository at one commit, and its notices. */
export interface PinnedSource {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly notices?: ReadonlyArray<string> | undefined;
}

/**
 * The files to write for `entry` from the commit's whole tree: everything under its folder, plus
 * its notices at the folder's top under their own names; `layout` names the file it must hold and
 * the install record it must not. Refuses the whole Skill on a symlink,
 * submodule, unsafe path, name clash, a listing git cut short, or limits passed.
 */
export function planFiles(
  entry: PinnedSource,
  tree: typeof GitTree.Type,
  layout: { readonly required: string; readonly manifest: string } = {
    required: "SKILL.md",
    manifest: MANIFEST_FILE,
  },
): Plan {
  if (tree.truncated) return refused("download", "the repository listing was cut short");
  const prefix = `${entry.path}/`;
  const files: PlannedFile[] = [];
  let bytes = 0;
  const add = (item: TreeItem, target: string): Plan | undefined => {
    if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")) {
      return refused("unsafe", `${item.path} is not a plain file`);
    }
    if (safeRelativePath(target) === null || target === layout.manifest) {
      return refused("unsafe", `${item.path} has an unsafe path`);
    }
    if (!/^[0-9a-f]{40}$/.test(item.sha)) return refused("download", `${item.path} has no id`);
    const size = item.size ?? 0;
    bytes += size;
    if (size > SKILL_LIMITS.fileBytes || bytes > SKILL_LIMITS.totalBytes) {
      return refused("unsafe", "the Skill is larger than the catalogue allows");
    }
    files.push({ source: item.path, target, sha: item.sha });
    return undefined;
  };
  for (const item of tree.tree) {
    if (!item.path.startsWith(prefix)) continue;
    if (item.type === "tree") continue;
    const failed = add(item, item.path.slice(prefix.length));
    if (failed !== undefined) return failed;
  }
  if (!files.some((file) => file.target === layout.required)) {
    return refused("download", `${entry.path}/${layout.required} is not in commit ${entry.commit}`);
  }
  for (const notice of entry.notices ?? []) {
    const item = tree.tree.find((candidate) => candidate.path === notice);
    if (item === undefined)
      return refused("download", `${notice} is not in commit ${entry.commit}`);
    const target = notice.slice(notice.lastIndexOf("/") + 1);
    if (files.some((file) => file.target.toLowerCase() === target.toLowerCase())) {
      return refused("unsafe", `${notice} clashes with a file of the Skill`);
    }
    const failed = add(item, target);
    if (failed !== undefined) return failed;
  }
  const lower = new Set(files.map((file) => file.target.toLowerCase()));
  if (lower.size !== files.length) return refused("unsafe", "two files differ only in case");
  if (files.length > SKILL_LIMITS.files) {
    return refused("unsafe", "the Skill has more files than the catalogue allows");
  }
  return { _tag: "Files", files };
}

/** `owner/repo` and a path as a URL path, each segment escaped. */
export const urlPath = (...parts: ReadonlyArray<string>) =>
  parts
    .flatMap((part) => part.split("/"))
    .map(encodeURIComponent)
    .join("/");
