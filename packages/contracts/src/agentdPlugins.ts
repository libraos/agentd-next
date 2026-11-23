import * as Schema from "effect/Schema";

import { MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";

// Plugins: folders from our catalogue, pinned to one commit, whose hooks the server runs. The only
// hook event is before-send: it sees an outgoing message and passes, rewrites or blocks it.

export const AgentdPluginHookEvent = Schema.Literal("before-send");
export type AgentdPluginHookEvent = typeof AgentdPluginHookEvent.Type;

/**
 * on: installed, enabled here and its hook command found; missing: enabled but its command is
 * not there, so sends stop; off: installed and not enabled; absent: not installed.
 */
export const AgentdPluginState = Schema.Literals(["on", "missing", "off", "absent"]);
export type AgentdPluginState = typeof AgentdPluginState.Type;

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
