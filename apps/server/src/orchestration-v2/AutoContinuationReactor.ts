import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  AUTO_CONTINUATION_PROMPT,
  autoContinuationStopMessage,
  decideAutoContinuation,
} from "@t3tools/shared/orchestrationV2AutoContinuation";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as AgentdPlugins from "../agentd/AgentdPlugins.ts";
import * as BeforeSendGate from "../agentd/beforeSendGate.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class AutoContinuationReactor extends Context.Service<
  AutoContinuationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/AutoContinuationReactor") {}

const SETTLED_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];

const PROGRESS_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "file_search",
  "web_search",
  "subagent",
]);

const STOP_TITLE = "Not continued automatically";

const autoContinuationIds = (runId: OrchestrationV2Run["id"]) => ({
  commandId: CommandId.make(`command:auto-continuation:${runId}`),
  messageId: MessageId.make(`message:auto-continuation:${runId}`),
});

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Optional, so a runtime without plugins dispatches as before.
  const beforeSendContext = Option.match(
    yield* Effect.serviceOption(AgentdPlugins.AgentdPluginsService),
    {
      onNone: () => Context.empty(),
      onSome: (plugins) => Context.make(AgentdPlugins.AgentdPluginsService, plugins),
    },
  );
  // The continuation's command is made once per run, after which that run is no longer the
  // latest and nothing here dispatches again, so there is never a receipt to replay.
  const beforeSendReads = BeforeSendGate.gateReads(engine, () => Effect.succeed(false));
  const noteStop = (threadId: ThreadId, runId: OrchestrationV2Run["id"], message: string) =>
    engine.noteRunSystemNotice({
      threadId,
      runId,
      signal: "auto-continuation-stop",
      title: STOP_TITLE,
      message,
    });

  const handle: AutoContinuationReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || !SETTLED_STATUSES.includes(event.payload.status)) return;
      const runId = event.payload.id;
      const projection = yield* projections.getThreadRecords(
        event.threadId,
        ["runs", "turnItems", "runtimeRequests", "nodes"],
        { turnItemRunIds: [runId] },
      );
      const { thread, runs } = projection;
      // Delegated children report to their parent, which decides what follows.
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.lineage.relationshipToParent === "subagent"
      )
        return;
      const run = runs.find((candidate) => candidate.id === runId);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.delegatedTaskId !== undefined ||
        !SETTLED_STATUSES.includes(run.status) ||
        // A later message, or a continuation already made for this run, owns what follows.
        runs.some((candidate) => candidate.ordinal > run.ordinal)
      )
        return;
      const items = projection.turnItems.filter((item) => item.runId === run.id);
      // Some harnesses put each reply in its own node under the root; a subagent's stays under its own node.
      const rootLevel = new Set([
        run.rootNodeId,
        ...projection.nodes
          .filter(
            (node) => node.parentNodeId === run.rootNodeId && node.kind === "assistant_message",
          )
          .map((node) => node.id),
      ]);
      // A stopped chain stays stopped: a repeat of this run's end does not ask the hooks again.
      if (items.some((item) => item.type === "system_notice" && item.title === STOP_TITLE)) return;
      const finalMessage = items
        .filter(
          (item): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
            item.type === "assistant_message" &&
            item.nodeId !== null &&
            rootLevel.has(item.nodeId) &&
            item.phase !== "commentary",
        )
        .reduce<Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> | undefined>(
          (latest, item) => (latest === undefined || item.ordinal > latest.ordinal ? item : latest),
          undefined,
        );
      let continuationsSoFar = 0;
      const visited = new Set<OrchestrationV2Run["id"]>();
      for (
        let source: OrchestrationV2Run | undefined = run;
        source?.autoContinuationOfRunId !== undefined && !visited.has(source.id);
        source = runs.find((candidate) => candidate.id === source?.autoContinuationOfRunId)
      ) {
        visited.add(source.id);
        continuationsSoFar += 1;
      }
      const resolved = yield* settings.getSettings.pipe(
        Effect.map((value) => resolveProjectSettings(value, thread.projectId).settings),
        Effect.orElseSucceed(() => null),
      );
      if (resolved === null) return;
      const decision = decideAutoContinuation({
        enabled: resolved.continueWhileWorkRemains,
        maxContinuations: resolved.maxAutomaticContinuations,
        runStatus: run.status === "completed" ? "completed" : (run.status as "failed"),
        finalMessage: finalMessage?.text,
        userStopped: items.some((item) => item.type === "run_interrupt_request"),
        awaitingUser:
          projection.runtimeRequests.some(
            (request) =>
              request.status === "pending" &&
              request.kind !== "dynamic_tool_call" &&
              request.kind !== "auth_refresh",
          ) ||
          items.some(
            (item) =>
              (item.type === "user_input_request" || item.type === "approval_request") &&
              (item.status === "pending" || item.status === "waiting"),
          ),
        usageLimited:
          thread.limitRecovery?.runId === run.id ||
          latestRootProviderFailure(run, items)?.class === "usage_limit",
        continuationsSoFar,
        madeProgress: items.some((item) => PROGRESS_ITEM_TYPES.has(item.type)),
      });
      if (decision.type === "none") return;
      if (decision.type === "stop") {
        yield* noteStop(
          thread.id,
          run.id,
          autoContinuationStopMessage(decision.reason, decision.remaining),
        );
        return;
      }
      const { commandId, messageId } = autoContinuationIds(run.id);
      const text = AUTO_CONTINUATION_PROMPT;
      const command = {
        type: "message.dispatch",
        commandId,
        threadId: thread.id,
        messageId,
        text,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: `Continuing automatically (${decision.continuation} of ${resolved.maxAutomaticContinuations})`,
          detail: text,
        },
        attachments: [],
        // The continuation keeps the source run's provider and model; the thread keeps its mode.
        modelSelection: run.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        autoContinuationOfRunId: run.id,
      } as const;
      // The before-send hooks see a continuation like any other send that is not a person's. Its
      // text is fixed (AUTO_CONTINUATION_PROMPT), so a redaction hook finds nothing to rewrite;
      // a hook that blocks, or still rewrites (which cannot be reviewed here), stops the chain
      // with the hook's reason, and nothing retries it.
      const gate = yield* BeforeSendGate.checkDispatch(command, beforeSendReads).pipe(
        Effect.provide(beforeSendContext),
        Effect.result,
      );
      if (gate._tag === "Failure") {
        yield* noteStop(thread.id, run.id, gate.failure.message);
        return;
      }
      yield* engine.dispatch(command);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("automatic continuation failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start: AutoContinuationReactor["Service"]["start"] = Effect.fn(
    "AutoContinuationReactor.start",
  )(function* () {
    const threadReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.updated"
          ? threadReactions.run(event.threadId, handle(event))
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("automatic continuation event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies AutoContinuationReactor["Service"];
});

export const layer = Layer.effect(AutoContinuationReactor, make);
