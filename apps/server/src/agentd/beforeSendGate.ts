import type {
  ChatAttachment,
  CommandId,
  MessageId,
  OrchestrationV2Command,
  OrchestrationV2CreationSource,
  OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";

// Where sends meet the before-send hooks. The intake checks what a client sends, before its
// attachments are claimed, and can hold a rewrite for review. Everything else that reaches
// dispatch with new content (MCP, scheduled tasks, launches not from a client) is checked there,
// where a rewrite cannot be reviewed and so stops the send.

/** A person at a client can review a rewrite of their own message. */
const reviewable = (createdBy: string, source: OrchestrationV2CreationSource) =>
  createdBy === "user" && (source === "web" || source === "mobile");

interface Message {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/** Reads the dispatch needs, given by the caller so this module does not own a thread store. */
export interface GateReads {
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly projectOf: (threadId: ThreadId) => Effect.Effect<ProjectId | null>;
  /** A queued run's message: its id and the attachments an edit without any keeps. */
  readonly queuedMessage: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<{
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  } | null>;
  readonly messageExists: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<boolean>;
  /** The pending guest message's text, which is what a guest send carries to the provider. */
  readonly guestText: (threadId: ThreadId, guestMessageId: string) => Effect.Effect<string | null>;
}

const plugins = Effect.serviceOption(AgentdPlugins.AgentdPluginsService);

const check = Effect.fn("beforeSendGate.check")(function* (
  service: AgentdPlugins.AgentdPluginsService["Service"],
  projectId: ProjectId,
  message: Message,
  source: OrchestrationV2CreationSource,
  resend: AgentdPlugins.BeforeSendResend | undefined,
) {
  if (!(yield* service.hasBeforeSend(projectId))) return;
  yield* service.checkBeforeSend({ projectId, ...message, source, resend });
});

/** A client's message.dispatch or queued-run.edit; other commands pass. */
export const checkClientCommand = Effect.fn("beforeSendGate.checkClientCommand")(function* (
  command: OrchestrationV2Command,
  reads: GateReads,
) {
  const service = yield* plugins;
  if (Option.isNone(service) || (yield* AgentdPlugins.BeforeSendChecked)) return;
  if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") return;
  // A guest's message is checked at dispatch, where its text is known.
  if (command.type === "message.dispatch" && command.guestMessageId !== undefined) return;
  if (yield* reads.hasReceipt(command.commandId)) return;
  const projectId = yield* reads.projectOf(command.threadId);
  if (projectId === null) return;
  if (command.type === "message.dispatch") {
    const resend = reviewable(command.createdBy, command.creationSource)
      ? ({ kind: "dispatch", command } as const)
      : undefined;
    return yield* check(service.value, projectId, command, command.creationSource, resend);
  }
  const queued = yield* reads.queuedMessage(command.threadId, command.runId);
  if (queued === null) return;
  yield* check(
    service.value,
    projectId,
    {
      threadId: command.threadId,
      messageId: queued.messageId,
      text: command.text,
      attachments: command.attachments ?? queued.attachments,
    },
    "web",
    { kind: "dispatch", command },
  );
});

/** A launch's first message; a person can review it only when the client named its id. */
export const checkLaunch = Effect.fn("beforeSendGate.checkLaunch")(function* (
  input: ThreadLaunchInput,
) {
  const service = yield* plugins;
  const initial = input.initialMessage;
  if (Option.isNone(service) || initial === undefined || input.threadId === undefined) return;
  if (yield* AgentdPlugins.BeforeSendChecked) return;
  const messageId = initial.messageId;
  yield* check(
    service.value,
    input.projectId,
    {
      threadId: input.threadId,
      messageId: messageId ?? ("" as MessageId),
      text: initial.text,
      attachments: initial.attachments,
    },
    input.creationSource,
    messageId !== undefined && reviewable(input.createdBy, input.creationSource)
      ? { kind: "launch", input }
      : undefined,
  );
});

const INTERNAL_FIELDS = [
  "notification",
  "delegatedCompletion",
  "idleCompaction",
  "restartContinuationOfRunId",
  "usageLimitContinuationOfRunId",
  "manualContinuationOfRunId",
  "steerFollowUpOfRunId",
  "usageLimitRecoveryRequestId",
] as const;

/**
 * The backstop at dispatch: new content not already checked by the intake. Re-dispatches of a
 * stored message, replays and the server's own continuations carry what was already confirmed.
 */
export const checkDispatch = Effect.fn("beforeSendGate.checkDispatch")(function* (
  command: OrchestrationV2ServerCommand,
  reads: GateReads,
) {
  const service = yield* plugins;
  if (Option.isNone(service) || (yield* AgentdPlugins.BeforeSendChecked)) return;
  if (command.type === "thread.create") {
    const initial = command.initialMessage;
    if (initial === undefined || (yield* reads.hasReceipt(command.commandId))) return;
    return yield* check(
      service.value,
      command.projectId,
      { threadId: command.threadId, ...initial },
      command.creationSource,
      undefined,
    );
  }
  if (command.type === "queued-run.edit") {
    return yield* checkClientCommandWithoutReview(service.value, command, reads);
  }
  if (command.type !== "message.dispatch" || command.createdBy === "system") return;
  if (INTERNAL_FIELDS.some((field) => command[field] !== undefined)) return;
  if (yield* reads.hasReceipt(command.commandId)) return;
  if (yield* reads.messageExists(command.threadId, command.messageId)) return;
  const projectId = yield* reads.projectOf(command.threadId);
  if (projectId === null) return;
  const text =
    command.guestMessageId === undefined
      ? command.text
      : yield* reads.guestText(command.threadId, command.guestMessageId);
  // A guest message no longer pending is refused by the orchestrator.
  if (text === null) return;
  yield* check(
    service.value,
    projectId,
    {
      ...command,
      text,
      attachments: command.guestMessageId === undefined ? command.attachments : [],
    },
    command.creationSource,
    undefined,
  );
});

const checkClientCommandWithoutReview = Effect.fn("beforeSendGate.checkQueuedEdit")(function* (
  service: AgentdPlugins.AgentdPluginsService["Service"],
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "queued-run.edit" }>,
  reads: GateReads,
) {
  if (yield* reads.hasReceipt(command.commandId)) return;
  const projectId = yield* reads.projectOf(command.threadId);
  const queued = yield* reads.queuedMessage(command.threadId, command.runId);
  if (projectId === null || queued === null) return;
  yield* check(
    service,
    projectId,
    {
      threadId: command.threadId,
      messageId: queued.messageId,
      text: command.text,
      attachments: command.attachments ?? queued.attachments,
    },
    "server",
    undefined,
  );
});

/** The intake's mark that a send's hooks ran, for everything it dispatches. */
export const checked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, AgentdPlugins.BeforeSendChecked, true);

type ThreadReads = Pick<
  Orchestrator.OrchestratorV2["Service"],
  "getThreadShell" | "getThreadRecords" | "getMessagesById" | "getThreadSnapshotWindow"
>;

/**
 * The gate's reads over the orchestrator. A failed read checks the message rather than skip it,
 * except where dispatch itself refuses (no thread, no queued run, no pending guest message).
 */
export const gateReads = (
  threads: ThreadReads,
  hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>,
): GateReads => ({
  hasReceipt,
  projectOf: (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    ),
  queuedMessage: (threadId, runId) =>
    threads.getThreadRecords(threadId, ["runs"], { runIds: [runId as never] }).pipe(
      Effect.flatMap((projection) => {
        const run = projection.runs.find((item) => item.id === runId && item.status === "queued");
        if (run === undefined) return Effect.succeed(null);
        return threads.getMessagesById(threadId, [run.userMessageId]).pipe(
          Effect.map((messages) => ({
            messageId: run.userMessageId,
            attachments: messages.get(run.userMessageId)?.attachments ?? [],
          })),
        );
      }),
      Effect.orElseSucceed(() => null),
    ),
  messageExists: (threadId, messageId) =>
    threads.getMessagesById(threadId, [messageId]).pipe(
      Effect.map((messages) => messages.has(messageId)),
      Effect.orElseSucceed(() => false),
    ),
  guestText: (threadId, guestMessageId) =>
    threads.getThreadSnapshotWindow(threadId, { rowLimit: 1 }).pipe(
      Effect.map(
        ({ projection }) =>
          projection.thread.guestShare?.messages.find(
            (message) => message.id === guestMessageId && message.status === "pending",
          )?.text ?? null,
      ),
      Effect.orElseSucceed(() => null),
    ),
});
