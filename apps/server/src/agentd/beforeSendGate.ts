import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as AgentdPlugins from "./AgentdPlugins.ts";

// Where sends meet the before-send hooks. The intake checks what a client sends, before its
// attachments are claimed, and can hold a rewrite for review. Everything else that reaches
// dispatch with new content (MCP, scheduled tasks, guest sends, launches not from a client) is
// checked there, where a rewrite cannot be reviewed and so stops the send.

/** A person at a client can review a rewrite of their own message. */
const reviewable = (createdBy: string, source: OrchestrationV2CreationSource) =>
  createdBy === "user" && (source === "web" || source === "mobile");

interface Message {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

type Content = Pick<Message, "text" | "attachments">;

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
  /** What is stored under a message id; a dispatch naming it stores its own text there. */
  readonly storedMessage: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Content | null>;
  /** The pending guest message's text, which is what a guest send carries to the provider. */
  readonly guestText: (threadId: ThreadId, guestMessageId: string) => Effect.Effect<string | null>;
}

const plugins = Effect.serviceOption(AgentdPlugins.AgentdPluginsService);

const alreadyChecked = Effect.fnUntraced(function* (commandId: CommandId) {
  return (yield* AgentdPlugins.BeforeSendChecked).has(commandId);
});

const sameContent = (a: Content, b: Content) =>
  a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);

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

/**
 * A client's message.dispatch or queued-run.edit; other commands pass. Answers whether the
 * command is covered here: only then may the intake mark it checked for the backstop.
 */
export const checkClientCommand = Effect.fn("beforeSendGate.checkClientCommand")(function* (
  command: OrchestrationV2Command,
  reads: GateReads,
) {
  const service = yield* plugins;
  if (Option.isNone(service)) return false;
  if (yield* alreadyChecked(command.commandId)) return true;
  if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") return false;
  // A guest's message is checked at dispatch, where the guest's own text is read.
  if (command.type === "message.dispatch" && command.guestMessageId !== undefined) return false;
  if (yield* reads.hasReceipt(command.commandId)) return true;
  const projectId = yield* reads.projectOf(command.threadId);
  if (projectId === null) return false;
  if (command.type === "message.dispatch") {
    const resend = reviewable(command.createdBy, command.creationSource)
      ? ({ kind: "dispatch", command } as const)
      : undefined;
    yield* check(service.value, projectId, command, command.creationSource, resend);
    return true;
  }
  const queued = yield* reads.queuedMessage(command.threadId, command.runId);
  if (queued === null) return false;
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
  return true;
});

/** The commands ThreadLaunchService dispatches a launch's first message in. */
export const launchMessageCommandIds = (input: Pick<ThreadLaunchInput, "commandId">) => [
  input.commandId,
  CommandId.make(`${input.commandId}:initial-message`),
];

/**
 * A launch's first message; a person can review it only when the client named its id. Answers
 * whether it was checked here, which needs the thread id.
 */
export const checkLaunch = Effect.fn("beforeSendGate.checkLaunch")(function* (
  input: ThreadLaunchInput,
) {
  const service = yield* plugins;
  const initial = input.initialMessage;
  if (Option.isNone(service) || initial === undefined || input.threadId === undefined) {
    return false;
  }
  if (yield* alreadyChecked(input.commandId)) return true;
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
  return true;
});

/**
 * The backstop at dispatch: new content not already checked by the intake. Replays, the system's
 * own messages and re-dispatches of exactly what is stored pass; anything else is checked,
 * whatever continuation fields it carries, since a client can set those too.
 */
export const checkDispatch = Effect.fn("beforeSendGate.checkDispatch")(function* (
  command: OrchestrationV2ServerCommand,
  reads: GateReads,
) {
  const service = yield* plugins;
  if (Option.isNone(service) || (yield* alreadyChecked(command.commandId))) return;
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
  // A reused command id replays its receipt and stores nothing new, whatever its text.
  if (yield* reads.hasReceipt(command.commandId)) return;
  const projectId = yield* reads.projectOf(command.threadId);
  if (projectId === null) return;
  const text =
    command.guestMessageId === undefined
      ? command.text
      : yield* reads.guestText(command.threadId, command.guestMessageId);
  // A guest message no longer pending is refused by the orchestrator.
  if (text === null) return;
  const content: Content = {
    text,
    attachments: command.guestMessageId === undefined ? command.attachments : [],
  };
  const stored = yield* reads.storedMessage(command.threadId, command.messageId);
  if (stored !== null && sameContent(stored, content)) return;
  yield* check(
    service.value,
    projectId,
    { ...command, ...content },
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

/** The intake's mark that these commands' hooks ran; nothing else it dispatches is marked. */
export const checked = Effect.fn("beforeSendGate.checked")(function* <A, E, R>(
  commandIds: ReadonlyArray<CommandId>,
  effect: Effect.Effect<A, E, R>,
) {
  const ids = yield* AgentdPlugins.BeforeSendChecked;
  return yield* Effect.provideService(
    effect,
    AgentdPlugins.BeforeSendChecked,
    new Set([...ids, ...commandIds]),
  );
});

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
  storedMessage: (threadId, messageId) =>
    threads.getMessagesById(threadId, [messageId]).pipe(
      Effect.map((messages) => {
        const message = messages.get(messageId);
        return message === undefined
          ? null
          : { text: message.text, attachments: message.attachments };
      }),
      Effect.orElseSucceed(() => null),
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
