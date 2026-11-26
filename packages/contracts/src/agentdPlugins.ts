import * as Schema from "effect/Schema";

import { MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";

// Plugins: folders from a catalogue (ours or one a person added), pinned to one commit, whose hooks the server runs. The only
// hook event is before-send: it sees an outgoing message and passes, rewrites or blocks it.

export const AgentdPluginHookEvent = Schema.Literal("before-send");
export type AgentdPluginHookEvent = typeof AgentdPluginHookEvent.Type;

/**
 * on: installed, enabled here and its hook command found; missing: enabled but its command is
 * not there or its setup has not succeeded, so sends stop; off: installed and not enabled;
 * absent: not installed.
 */
export const AgentdPluginState = Schema.Literals(["on", "missing", "off", "absent"]);
export type AgentdPluginState = typeof AgentdPluginState.Type;

/** needed: never run or interrupted for the installed version; running; ready: exit 0; failed. */
export const AgentdPluginSetupStatus = Schema.Literals(["needed", "running", "ready", "failed"]);
export type AgentdPluginSetupStatus = typeof AgentdPluginSetupStatus.Type;

/** A plugin whose manifest declares a setup step, run on the server before it can be turned on. */
export const AgentdPluginSetup = Schema.Struct({
  /** The manifest's sentence: what setup downloads and how much disk it needs. */
  description: Schema.String,
  status: AgentdPluginSetupStatus,
  /** While running: the last line setup printed. */
  progress: Schema.optionalKey(Schema.String),
  /** When failed: why. */
  reason: Schema.optionalKey(Schema.String),
});
export type AgentdPluginSetup = typeof AgentdPluginSetup.Type;

/** A setting the plugin needs; a secret one never leaves the server, only whether it is set. */
export const AgentdPluginSettingListing = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  secret: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  /** Not secret: the value given, else the manifest's default. */
  value: Schema.optionalKey(Schema.String),
  /** A value was given (for a secret, one is in the secret store). */
  set: Schema.Boolean,
});
export type AgentdPluginSettingListing = typeof AgentdPluginSettingListing.Type;

/** An MCP server the plugin gives the agents the app launches, exactly as it will be started. */
export const AgentdPluginMcpServer = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  /** The env var names it gets; values are not listed. */
  env: Schema.Array(Schema.String),
  /** Settings it needs that have no value yet; until given, it is not attached. */
  missing: Schema.Array(Schema.String),
});
export type AgentdPluginMcpServer = typeof AgentdPluginMcpServer.Type;

/**
 * Where a plugin came from: the official catalogue, a GitHub catalogue a person added (its
 * repository, lower case), or a local folder in developer mode (not pinned).
 */
export const AgentdPluginOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("official") }),
  Schema.Struct({ kind: Schema.Literal("github"), repository: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("local"), path: Schema.String }),
]);
export type AgentdPluginOrigin = typeof AgentdPluginOrigin.Type;

export const AgentdPluginListing = Schema.Struct({
  /** The plugin's key, per source: the bare id for an official plugin. Every command takes it. */
  id: Schema.String,
  origin: AgentdPluginOrigin,
  name: Schema.String,
  description: Schema.String,
  author: Schema.String,
  licence: Schema.String,
  /** The catalogue's version; the installed one may differ until it is installed again. */
  version: Schema.String,
  installedVersion: Schema.optionalKey(Schema.String),
  hooks: Schema.Array(AgentdPluginHookEvent),
  /** The environment's setting. */
  enabled: Schema.Boolean,
  /** The project's override, when one was asked for and set. */
  projectEnabled: Schema.optionalKey(Schema.Boolean),
  /** For the project asked for, or the environment. */
  state: AgentdPluginState,
  /** Present when the installed version declares setup. */
  setup: Schema.optionalKey(AgentdPluginSetup),
  /** The installed version's MCP servers; given to Claude Code and Codex launches while on. */
  mcpServers: Schema.optionalKey(Schema.Array(AgentdPluginMcpServer)),
  settings: Schema.optionalKey(Schema.Array(AgentdPluginSettingListing)),
  /** A local plugin whose manifest is refused now: why. It is not run until it reads again. */
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Installed from a catalogue that is no longer a source: it stays and runs, but cannot update. */
  sourceRemoved: Schema.optionalKey(Schema.Literal(true)),
});
export type AgentdPluginListing = typeof AgentdPluginListing.Type;

/** fetched today, the cache, none (no cache and the fetch failed). */
export const AgentdPluginCatalogState = Schema.Literals(["fetched", "cache", "none"]);
export type AgentdPluginCatalogState = typeof AgentdPluginCatalogState.Type;

/** A catalogue the plugins are listed from; a token is never listed, only whether one is kept. */
export const AgentdPluginSourceListing = Schema.Struct({
  /** owner/repo, lower case. */
  repository: Schema.String,
  /** The official catalogue: always there, cannot be removed. */
  official: Schema.Boolean,
  hasToken: Schema.Boolean,
  /** Read with the server's GitHub connection (Settings, Source control), as the person confirmed. */
  githubConnection: Schema.optionalKey(Schema.Literal(true)),
  state: AgentdPluginCatalogState,
});
export type AgentdPluginSourceListing = typeof AgentdPluginSourceListing.Type;

export const AgentdPlugins = Schema.Struct({
  /** The official catalogue's state. */
  source: AgentdPluginCatalogState,
  /** The official catalogue first, then those a person added. */
  sources: Schema.Array(AgentdPluginSourceListing),
  /** Local folders can be added as plugins; off by default. */
  developerMode: Schema.Boolean,
  plugins: Schema.Array(AgentdPluginListing),
  /** After adding a source from a plugin folder's link: that plugin's key, to offer its install. */
  linked: Schema.optionalKey(Schema.String),
  /** Whether a send in the project asked for runs at least one before-send hook. */
  beforeSend: Schema.Boolean,
});
export type AgentdPlugins = typeof AgentdPlugins.Type;

export const AgentdPluginsListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentdPluginsListInput = typeof AgentdPluginsListInput.Type;

export const AgentdPluginInput = Schema.Struct({ id: Schema.String });
export type AgentdPluginInput = typeof AgentdPluginInput.Type;

export const AgentdPluginRemoveInput = Schema.Struct({
  id: Schema.String,
  /** Also delete the plugin's data folder (what its setup downloaded). */
  deleteData: Schema.optionalKey(Schema.Boolean),
});
export type AgentdPluginRemoveInput = typeof AgentdPluginRemoveInput.Type;

export const AgentdPluginSettingsInput = Schema.Struct({
  id: Schema.String,
  /** Setting name to its new value; null clears it. Secret values go to the secret store. */
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});
export type AgentdPluginSettingsInput = typeof AgentdPluginSettingsInput.Type;

export const AgentdPluginSourceInput = Schema.Struct({
  /**
   * owner/repo, or a GitHub link: the repository, a plugin folder in it (.../tree/BRANCH/PATH) or
   * its catalog.json.
   */
  repository: Schema.String,
  /** A read-only token for a private repository (fine-grained, Contents: read). Kept in the
   * server's secret store and sent only to the GitHub API for this repository. */
  token: Schema.optionalKey(Schema.String),
  /**
   * The person confirmed reading this repository with the server's GitHub connection: the GitHub
   * App where it covers the repository, else the account's own credential. Read for each fetch and
   * never kept by plugins.
   */
  useGitHubConnection: Schema.optionalKey(Schema.Boolean),
});
export type AgentdPluginSourceInput = typeof AgentdPluginSourceInput.Type;

export const AgentdPluginSourceRemoveInput = Schema.Struct({ repository: Schema.String });
export type AgentdPluginSourceRemoveInput = typeof AgentdPluginSourceRemoveInput.Type;

export const AgentdPluginDeveloperModeInput = Schema.Struct({ enabled: Schema.Boolean });
export type AgentdPluginDeveloperModeInput = typeof AgentdPluginDeveloperModeInput.Type;

export const AgentdPluginLocalInput = Schema.Struct({
  /** An absolute folder on the server holding agentd-plugin.json. */
  path: Schema.String,
});
export type AgentdPluginLocalInput = typeof AgentdPluginLocalInput.Type;

export const AgentdPluginEnableInput = Schema.Struct({
  id: Schema.String,
  /** null clears a project's override. */
  enabled: Schema.NullOr(Schema.Boolean),
  /** Sets the project's override instead of the environment's setting. */
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentdPluginEnableInput = typeof AgentdPluginEnableInput.Type;

export const AgentdPluginErrorReason = Schema.Literals([
  "unknown",
  "download",
  "unsafe",
  "filesystem",
  "invalid",
  "setup",
  /** The repository did not read anonymously: ask to use the GitHub connection, or connect one. */
  "githubConnection",
]);
export type AgentdPluginErrorReason = typeof AgentdPluginErrorReason.Type;

export class AgentdPluginError extends Schema.TaggedError<AgentdPluginError>()(
  "AgentdPluginError",
  {
    reason: AgentdPluginErrorReason,
    message: Schema.String,
    /**
     * With githubConnection: the repository to ask about, and whether the server had a connection
     * to read it with (false once the person confirmed and there was none).
     */
    githubConnection: Schema.optionalKey(
      Schema.Struct({ repository: Schema.String, connected: Schema.Boolean }),
    ),
  },
) {}

/** A UTF-8 text attachment as a before-send hook sees it, and as the review shows it. */
export const AgentdBeforeSendAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  text: Schema.String,
});
export type AgentdBeforeSendAttachment = typeof AgentdBeforeSendAttachment.Type;

export const AgentdBeforeSendContent = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(AgentdBeforeSendAttachment),
});
export type AgentdBeforeSendContent = typeof AgentdBeforeSendContent.Type;

/**
 * A thread's placeholders, each to the original value it stands for. Kept by the server, given to
 * before-send hooks and to clients, which show replies with the originals; providers never see it.
 */
export const AgentdPlaceholderMap = Schema.Record(Schema.String, Schema.String);
export type AgentdPlaceholderMap = typeof AgentdPlaceholderMap.Type;

export const AgentdPlaceholdersInput = Schema.Struct({ threadId: ThreadId });
export type AgentdPlaceholdersInput = typeof AgentdPlaceholdersInput.Type;

/** A placeholder in a proposed message; new: not yet in the thread's map. */
export const AgentdBeforeSendPlaceholder = Schema.Struct({
  placeholder: Schema.String,
  value: Schema.String,
  new: Schema.Boolean,
});
export type AgentdBeforeSendPlaceholder = typeof AgentdBeforeSendPlaceholder.Type;

/** A send a before-send hook rewrote, held by the server until the person confirms or closes it. */
export const AgentdBeforeSendReview = Schema.Struct({
  reviewId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  /** The plugins whose hooks changed the message. */
  plugins: Schema.Array(Schema.String),
  original: AgentdBeforeSendContent,
  proposed: AgentdBeforeSendContent,
  /** The placeholders the proposed message uses, in the order they first appear. */
  placeholders: Schema.Array(AgentdBeforeSendPlaceholder),
  /**
   * Files a hook replaced with text: the proposed attachment with the same id is their text, and
   * the file itself is not sent. `name` is the file's own name.
   */
  replacedFiles: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type AgentdBeforeSendReview = typeof AgentdBeforeSendReview.Type;

export const AgentdBeforeSendReviewInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type AgentdBeforeSendReviewInput = typeof AgentdBeforeSendReviewInput.Type;

export const AgentdBeforeSendConfirmInput = Schema.Struct({
  reviewId: Schema.String,
  /** The content the person confirmed, edited or not; attachments by id, text ones only. A replaced file left out goes as its proposed text. */
  content: AgentdBeforeSendContent,
});
export type AgentdBeforeSendConfirmInput = typeof AgentdBeforeSendConfirmInput.Type;

export const AgentdBeforeSendDiscardInput = Schema.Struct({ reviewId: Schema.String });
export type AgentdBeforeSendDiscardInput = typeof AgentdBeforeSendDiscardInput.Type;

/** review: a hook rewrote the message and the person has to confirm it; blocked: it is not sent. */
export class AgentdBeforeSendError extends Schema.TaggedError<AgentdBeforeSendError>()(
  "AgentdBeforeSendError",
  {
    reason: Schema.Literals(["review", "blocked"]),
    message: Schema.String,
    reviewId: Schema.optionalKey(Schema.String),
  },
) {}
