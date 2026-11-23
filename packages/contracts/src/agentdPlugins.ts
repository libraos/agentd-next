import * as Schema from "effect/Schema";

import { MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";

// Plugins: folders from our catalogue, pinned to one commit, whose hooks the server runs. The only
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

export const AgentdPluginListing = Schema.Struct({
  id: Schema.String,
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
});
export type AgentdPluginListing = typeof AgentdPluginListing.Type;

export const AgentdPlugins = Schema.Struct({
  /** fetched today, the cache, none (no cache and the fetch failed). */
  source: Schema.Literals(["fetched", "cache", "none"]),
  plugins: Schema.Array(AgentdPluginListing),
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
]);
export type AgentdPluginErrorReason = typeof AgentdPluginErrorReason.Type;

export class AgentdPluginError extends Schema.TaggedError<AgentdPluginError>()(
  "AgentdPluginError",
  {
    reason: AgentdPluginErrorReason,
    message: Schema.String,
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

/** A send a before-send hook rewrote, held by the server until the person confirms or closes it. */
export const AgentdBeforeSendReview = Schema.Struct({
  reviewId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  /** The plugins whose hooks changed the message. */
  plugins: Schema.Array(Schema.String),
  original: AgentdBeforeSendContent,
  proposed: AgentdBeforeSendContent,
});
export type AgentdBeforeSendReview = typeof AgentdBeforeSendReview.Type;

export const AgentdBeforeSendReviewInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type AgentdBeforeSendReviewInput = typeof AgentdBeforeSendReviewInput.Type;

export const AgentdBeforeSendConfirmInput = Schema.Struct({
  reviewId: Schema.String,
  /** The content the person confirmed, edited or not; attachments by id, text ones only. */
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
