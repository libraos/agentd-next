// @effect-diagnostics nodeBuiltinImport:off - paths for another OS.
import * as NodePath from "node:path";

import type { AgentdBeforeSendContent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CatalogSource, resolveInside, safeRelativePath } from "./skillCatalog.ts";

// The plugin catalogue's pure parts: its format, a plugin's manifest, the enabled setting, and the
// before-send hook's protocol. A hook is a command run with one JSON object on stdin that prints
// one JSON object on stdout; anything else stops the send.

export const PLUGIN_CATALOG_URL =
  "https://raw.githubusercontent.com/libraos/plugins/main/catalog.json";
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

const HookCommand = Schema.Struct({
  /** argv; a first element with a slash is a file in the plugin's folder, else found on PATH. */
  command: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(60)),
  ),
});
export type HookCommand = typeof HookCommand.Type;

/** `agentd-plugin.json` at the top of a plugin's folder. */
export const PluginManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  hooks: Schema.Struct({ "before-send": Schema.optionalKey(HookCommand) }),
});
export type PluginManifest = typeof PluginManifest.Type;
export const decodePluginManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(PluginManifest),
);

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

/** Which plugins are on: for the environment, and per project where it differs. */
export const PluginSettings = Schema.Struct({
  enabled: Schema.Record(Schema.String, Schema.Boolean),
  projects: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
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
  return { enabled, projects };
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

const HookAttachmentOut = Schema.Struct({ id: Schema.String, text: Schema.String });
const HookOutput = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("pass") }),
  Schema.Struct({
    decision: Schema.Literal("rewrite"),
    message: Schema.Struct({
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(HookAttachmentOut)),
    }),
  }),
  Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }),
]);
const decodeHookOutput = Schema.decodeUnknownOption(Schema.fromJsonString(HookOutput));

export type HookDecision =
  | { readonly _tag: "Pass" }
  | { readonly _tag: "Rewrite"; readonly content: AgentdBeforeSendContent }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Invalid" };

/**
 * What a hook printed, against what it was given. A rewrite may replace the text and the text of
 * attachments it was shown; one naming any other attachment is invalid, as is anything that is not
 * exactly one decision. A rewrite to the same content is a pass.
 */
export function parseHookOutput(stdout: string, input: AgentdBeforeSendContent): HookDecision {
  const decoded = decodeHookOutput(stdout.trim());
  if (decoded._tag === "None") return { _tag: "Invalid" };
  const output = decoded.value;
  if (output.decision === "pass") return { _tag: "Pass" };
  if (output.decision === "block") {
    const reason = output.reason.trim().slice(0, 500);
    return { _tag: "Block", reason };
  }
  const replaced = new Map<string, string>();
  for (const attachment of output.message.attachments ?? []) {
    if (replaced.has(attachment.id)) return { _tag: "Invalid" };
    replaced.set(attachment.id, attachment.text);
  }
  if ([...replaced.keys()].some((id) => !input.attachments.some((known) => known.id === id))) {
    return { _tag: "Invalid" };
  }
  const content: AgentdBeforeSendContent = {
    text: output.message.text,
    attachments: input.attachments.map((attachment) => ({
      ...attachment,
      text: replaced.get(attachment.id) ?? attachment.text,
    })),
  };
  return sameContent(content, input) ? { _tag: "Pass" } : { _tag: "Rewrite", content };
}

export const sameContent = (left: AgentdBeforeSendContent, right: AgentdBeforeSendContent) =>
  left.text === right.text &&
  left.attachments.length === right.attachments.length &&
  left.attachments.every(
    (attachment, index) =>
      attachment.id === right.attachments[index]?.id &&
      attachment.text === right.attachments[index]?.text,
  );

/** What a hook reads on stdin; `unshownAttachments` go with the message but the hook cannot read them. */
export const hookInput = (input: {
  readonly content: AgentdBeforeSendContent;
  readonly unshown: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly projectId: string;
  readonly threadId: string;
  readonly source: string;
}) =>
  JSON.stringify({
    version: 1,
    event: "before-send",
    message: input.content,
    unshownAttachments: input.unshown,
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
