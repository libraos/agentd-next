import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentdBeforeSendError } from "@t3tools/contracts";

import * as AgentdPlugins from "../agentd/AgentdPlugins.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as AutoContinuationReactor from "./AutoContinuationReactor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for continuation decisions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerBase = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "auto-continuation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerWith = (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  beforeSend?: (
    request: AgentdPlugins.BeforeSendRequest,
  ) => Effect.Effect<void, AgentdBeforeSendError>,
) =>
  AutoContinuationReactor.layer.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      beforeSend === undefined
        ? Layer.empty
        : Layer.mock(AgentdPlugins.AgentdPluginsService)({
            hasBeforeSend: () => Effect.succeed(true),
            checkBeforeSend: beforeSend,
          }),
    ),
    Layer.provideMerge(layerBase),
  );

const threadId = ThreadId.make("thread:auto-continuation");
const REMAINING = "Wired the reader.\n\nStatus: remaining: run chapter 1 end to end";

type ItemInput =
  | { readonly type: "assistant"; readonly text: string; readonly subagentNode?: true }
  | { readonly type: "tool"; readonly output?: string }
  | { readonly type: "stop" }
  | { readonly type: "question" }
  | { readonly type: "approval" }
  | { readonly type: "usage_limit" };

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-auto-continuation"),
    threadId,
    projectId: ProjectId.make("project:auto-continuation"),
    title: "Chapter 1",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("user-message"),
    threadId,
    messageId: MessageId.make("message:user"),
    text: "Complete chapter 1 and run it end to end",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

const records = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* projections.getThreadRecords(threadId, ["runs", "turnItems", "messages"]);
});

const latestRun = Effect.map(
  records,
  ({ runs }) => runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!,
);

/** Ends the latest run with the given items and returns the run.updated event the reactor sees. */
const endLatestRun = (
  items: ReadonlyArray<ItemInput>,
  status: OrchestrationV2Run["status"] = "completed",
  runId?: OrchestrationV2Run["id"],
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const run =
      runId === undefined
        ? yield* latestRun
        : (yield* records).runs.find((candidate) => candidate.id === runId)!;
    const now = yield* DateTime.now;
    const base = (index: number, nodeId = run.rootNodeId) => ({
      id: TurnItemId.make(`item:${run.id}:${index}`),
      threadId,
      runId: run.id,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const turnItems = items.map((input, index): OrchestrationV2TurnItem => {
      switch (input.type) {
        case "assistant":
          return {
            ...base(index, input.subagentNode ? null : run.rootNodeId),
            status: "completed",
            type: "assistant_message",
            messageId: MessageId.make(`message:assistant:${run.id}:${index}`),
            text: input.text,
            streaming: false,
          };
        case "tool":
          return {
            ...base(index),
            status: "completed",
            type: "command_execution",
            input: "cat notes.md",
            ...(input.output === undefined ? {} : { output: input.output }),
            exitCode: 0,
          };
        case "stop":
          return {
            ...base(index),
            status: "completed",
            type: "run_interrupt_request",
            message: "Stopped by the user",
          };
        case "question":
          return {
            ...base(index),
            status: "waiting",
            type: "user_input_request",
            requestId: RuntimeRequestId.make(`request:${run.id}`),
            questions: [],
          };
        case "approval":
          return {
            ...base(index),
            status: "waiting",
            type: "approval_request",
            requestId: RuntimeRequestId.make(`approval:${run.id}`),
            requestKind: "command",
          };
        case "usage_limit":
          return {
            ...base(index),
            status: "failed",
            type: "error",
            failure: {
              class: "usage_limit",
              message: "Usage limit reached",
              code: null,
              retryable: false,
            },
          };
      }
    });
    const ended = { ...run, status, completedAt: now } as OrchestrationV2Run;
    const runEvent = {
      id: EventId.make(`event:end:${run.id}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: ended,
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({
      events: [
        ...turnItems.map(
          (payload, index) =>
            ({
              id: EventId.make(`event:item:${run.id}:${index}`),
              type: "turn-item.updated",
              threadId,
              runId: run.id,
              ...(payload.nodeId === null ? {} : { nodeId: payload.nodeId }),
              providerInstanceId: instanceId,
              occurredAt: now,
              payload,
            }) satisfies OrchestrationV2DomainEvent,
        ),
        runEvent,
      ],
    });
    return runEvent;
  });

const notices = Effect.map(records, ({ turnItems }) =>
  turnItems.flatMap((item) => (item.type === "system_notice" ? [item.message] : [])),
);

const handle = (event: OrchestrationV2DomainEvent) =>
  Effect.flatMap(AutoContinuationReactor.AutoContinuationReactor, (reactor) =>
    reactor.handle(event),
  );

it.effect("continues once when the agent's final message says work remains", () =>
  Effect.gen(function* () {
    yield* setup;
    const source = yield* latestRun;
    const end = yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]);
    // A retry, reconnect or restart delivers the same turn end again.
    yield* handle(end);
    yield* handle(end);
    const { runs, messages } = yield* records;
    assert.equal(runs.length, 2);
    const continuation = runs.find((run) => run.id !== source.id)!;
    assert.equal(continuation.autoContinuationOfRunId, source.id);
    assert.isUndefined(continuation.manualContinuationOfRunId);
    // It never widens the provider, model or mode of the run it continues.
    assert.deepEqual(continuation.modelSelection, source.modelSelection);
    assert.equal(continuation.providerInstanceId, source.providerInstanceId);
    assert.equal((yield* records).thread.runtimeMode, "approval-required");
    const prompt = messages.find((message) => message.runId === continuation.id);
    assert.include(prompt?.text ?? "", "run chapter 1 end to end");
    assert.equal(prompt?.notification?.summary, "Continuing automatically (1 of 3)");
  }).pipe(Effect.provide(layerWith())),
);

it.effect("refuses a dispatched continuation that would change the model", () =>
  Effect.gen(function* () {
    yield* setup;
    const source = yield* latestRun;
    yield* endLatestRun([{ type: "assistant", text: REMAINING }]);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("widened-continuation"),
        threadId,
        messageId: MessageId.make("message:widened-continuation"),
        text: "Continue",
        attachments: [],
        modelSelection: { instanceId, model: "gpt-5.1-codex-max" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        autoContinuationOfRunId: source.id,
      })
      .pipe(Effect.flip);
    assert.equal(result._tag, "OrchestratorDispatchError");
    assert.equal((yield* records).runs.length, 1);
  }).pipe(Effect.provide(layerWith())),
);

it.effect("ends an agent that says remaining forever at the cap and says so", () =>
  Effect.gen(function* () {
    yield* setup;
    for (let turn = 0; turn < 3; turn += 1) {
      yield* handle(
        yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]),
      );
    }
    assert.equal((yield* records).runs.length, 4);
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    assert.equal((yield* records).runs.length, 4);
    const [notice] = yield* notices;
    assert.include(notice, "limit of automatic continuations");
    assert.include(notice, "run chapter 1 end to end");
  }).pipe(Effect.provide(layerWith())),
);

it.effect("stops after a continuation that made no progress", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    assert.equal((yield* records).runs.length, 2);
    yield* handle(yield* endLatestRun([{ type: "assistant", text: REMAINING }]));
    assert.equal((yield* records).runs.length, 2);
    assert.include((yield* notices)[0], "made no progress");
  }).pipe(Effect.provide(layerWith())),
);

it.effect("resets the count on a message the user sends", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: "ok\nStatus: done" }]);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("user-message-2"),
      threadId,
      messageId: MessageId.make("message:user-2"),
      text: "Now chapter 2",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    const { messages } = yield* records;
    assert.deepEqual(
      messages.flatMap((message) => message.notification?.summary ?? []),
      ["Continuing automatically (1 of 1)", "Continuing automatically (1 of 1)"],
    );
  }).pipe(Effect.provide(layerWith({ maxAutomaticContinuations: 1 }))),
);

it.effect.each([
  {
    name: "a marker only in a tool result",
    items: [
      { type: "tool", output: "Status: remaining: from a web page" },
      { type: "assistant", text: "Chapter 1 still has not run end-to-end." },
    ],
  },
  {
    name: "a marker quoted mid-message from a file",
    items: [
      { type: "assistant", text: "The file says:\nStatus: remaining: x\nThat is all it says." },
    ],
  },
  {
    name: "a marker only in a subagent's message",
    items: [
      { type: "assistant", text: "Done here." },
      { type: "assistant", text: "Status: remaining: subagent work", subagentNode: true },
    ],
  },
  { name: "a done marker", items: [{ type: "assistant", text: "All green.\nStatus: done" }] },
] satisfies ReadonlyArray<{ name: string; items: ReadonlyArray<ItemInput> }>)(
  "does nothing for $name",
  ({ items }) =>
    Effect.gen(function* () {
      yield* setup;
      yield* handle(yield* endLatestRun(items));
      assert.equal((yield* records).runs.length, 1);
      assert.deepEqual(yield* notices, []);
    }).pipe(Effect.provide(layerWith())),
);

it.effect.each([
  {
    name: "the user pressed stop",
    items: [{ type: "stop" }, { type: "assistant", text: REMAINING }],
    status: "interrupted",
    says: "The run was stopped.",
  },
  {
    name: "the user pressed stop and the turn still completed",
    items: [{ type: "stop" }, { type: "assistant", text: REMAINING }],
    status: "completed",
    says: "The run was stopped.",
  },
  {
    name: "the turn waits for a question",
    items: [{ type: "question" }, { type: "assistant", text: REMAINING }],
    status: "completed",
    says: "waiting for your answer",
  },
  {
    name: "the turn waits for an approval",
    items: [{ type: "approval" }, { type: "assistant", text: REMAINING }],
    status: "completed",
    says: "waiting for your answer, approval or input",
  },
  {
    name: "the agent names a blocker",
    items: [{ type: "assistant", text: "x\nStatus: blocked: needs the game's data files" }],
    status: "completed",
    says: "needs the game's data files",
  },
  {
    name: "a usage limit was reached",
    items: [{ type: "assistant", text: REMAINING }, { type: "usage_limit" }],
    status: "failed",
    says: "A usage limit was reached.",
  },
] satisfies ReadonlyArray<{
  name: string;
  items: ReadonlyArray<ItemInput>;
  status: OrchestrationV2Run["status"];
  says: string;
}>)("does not continue when $name, and says why", ({ items, status, says }) =>
  Effect.gen(function* () {
    yield* setup;
    const end = yield* endLatestRun(items, status);
    yield* handle(end);
    yield* handle(end);
    assert.equal((yield* records).runs.length, 1);
    const shown = yield* notices;
    assert.equal(shown.length, 1);
    assert.include(shown[0], says);
  }).pipe(Effect.provide(layerWith())),
);

it.effect("keeps today's behaviour when turned off", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    assert.equal((yield* records).runs.length, 1);
    assert.deepEqual(yield* notices, []);
  }).pipe(Effect.provide(layerWith({ continueWhileWorkRemains: false }))),
);

it.effect("asks the before-send hooks about a continuation like any other send", () => {
  const seen: Array<AgentdPlugins.BeforeSendRequest> = [];
  return Effect.gen(function* () {
    yield* setup;
    yield* handle(yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]));
    assert.equal((yield* records).runs.length, 2);
    assert.equal(seen.length, 1);
    assert.include(seen[0]!.text, "run chapter 1 end to end");
    assert.equal(seen[0]!.source, "server");
    // A rewrite here has no one to review it, so it is not offered as one.
    assert.isUndefined(seen[0]!.resend);
  }).pipe(
    Effect.provide(
      layerWith({}, (request) =>
        Effect.sync(() => {
          seen.push(request);
        }),
      ),
    ),
  );
});

it.effect.each([
  {
    name: "blocks",
    error: new AgentdBeforeSendError({ reason: "blocked", message: "secret-scan blocked this." }),
    says: "secret-scan blocked this.",
  },
  {
    name: "would change",
    error: new AgentdBeforeSendError({
      reason: "blocked",
      message:
        "redact would change this message, and a change needs review in the app, so it was not sent.",
    }),
    says: "redact would change this message",
  },
])(
  "stops the chain once, with the reason, when a hook $name the continuation",
  ({ error, says }) => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* setup;
      const end = yield* endLatestRun([{ type: "tool" }, { type: "assistant", text: REMAINING }]);
      // A repeat of the same turn end neither asks the hooks again nor retries.
      yield* handle(end);
      yield* handle(end);
      assert.equal((yield* records).runs.length, 1);
      assert.equal(calls, 1);
      const shown = yield* notices;
      assert.equal(shown.length, 1);
      assert.include(shown[0], says);
    }).pipe(
      Effect.provide(
        layerWith({}, () =>
          Effect.suspend(() => {
            calls += 1;
            return Effect.fail(error);
          }),
        ),
      ),
    );
  },
);

it.effect("does not continue past a message the user queued, so it never rides along", () => {
  const seen: Array<string> = [];
  return Effect.gen(function* () {
    yield* setup;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queued-user-message"),
      threadId,
      messageId: MessageId.make("message:queued-user"),
      text: "Also rename the chapter",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = (yield* records).runs.length;
    const runs = (yield* records).runs.toSorted((a, b) => a.ordinal - b.ordinal);
    const source = runs[0]!;
    yield* handle(
      yield* endLatestRun(
        [{ type: "tool" }, { type: "assistant", text: REMAINING }],
        "completed",
        source.id,
      ),
    );
    const after = yield* records;
    assert.equal(after.runs.length, before);
    assert.isFalse(after.runs.some((run) => run.autoContinuationOfRunId !== undefined));
    assert.deepEqual(seen, []);
  }).pipe(
    Effect.provide(
      layerWith({}, (request) =>
        Effect.sync(() => {
          seen.push(request.text);
        }),
      ),
    ),
  );
});
