import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentdPlugins from "./AgentdPlugins.ts";
import * as BeforeSendGate from "./beforeSendGate.ts";

const threadId = ThreadId.make("thread:gate");

const reads: BeforeSendGate.GateReads = {
  hasReceipt: () => Effect.succeed(false),
  projectOf: () => Effect.succeed(ProjectId.make("project:gate")),
  queuedMessage: () => Effect.succeed(null),
  storedMessage: () => Effect.succeed(null),
  guestText: () => Effect.succeed(null),
};

const dispatch = (id: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(`message:${id}`),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  }) as const;

it.effect("the checked mark covers only the commands it names", () => {
  const seen: string[] = [];
  return Effect.gen(function* () {
    yield* BeforeSendGate.checked(
      [CommandId.make("checked")],
      Effect.all([
        BeforeSendGate.checkDispatch(dispatch("checked", "already checked"), reads),
        BeforeSendGate.checkDispatch(dispatch("later", "dispatched later"), reads),
      ]),
    );
    assert.deepEqual(seen, ["dispatched later"]);
  }).pipe(
    Effect.provide(
      Layer.mock(AgentdPlugins.AgentdPluginsService)({
        hasBeforeSend: () => Effect.succeed(true),
        checkBeforeSend: (request) =>
          Effect.sync(() => {
            seen.push(request.text);
          }),
      }),
    ),
  );
});

it.effect("continuation fields do not exempt a dispatch from the hooks", () => {
  const seen: string[] = [];
  return Effect.gen(function* () {
    yield* BeforeSendGate.checkDispatch(
      {
        ...dispatch("auto", "Status: remaining: from the agent"),
        autoContinuationOfRunId: RunId.make("run:source"),
      },
      reads,
    );
    yield* BeforeSendGate.checkDispatch(
      {
        ...dispatch("typed", "text a user typed"),
        createdBy: "user",
        autoContinuationOfRunId: RunId.make("run:source"),
      },
      reads,
    );
    assert.deepEqual(seen, ["Status: remaining: from the agent", "text a user typed"]);
  }).pipe(
    Effect.provide(
      Layer.mock(AgentdPlugins.AgentdPluginsService)({
        hasBeforeSend: () => Effect.succeed(true),
        checkBeforeSend: (request) =>
          Effect.sync(() => {
            seen.push(request.text);
          }),
      }),
    ),
  );
});
