import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { AgentdPluginsService } from "./AgentdPlugins.ts";

// A thread's placeholder map goes with the thread: on its deletion, and at start for any thread
// deleted or gone while the server was not listening.

type Threads = Pick<
  Orchestrator.OrchestratorV2["Service"],
  "streamDomainEvents" | "getThreadShell"
>;
type Maps = Pick<AgentdPluginsService["Service"], "forgetPlaceholders" | "placeholderThreads">;

export const forgetDeletedThreads = Effect.fn("placeholderCleanup.forgetDeletedThreads")(function* (
  threads: Threads,
  maps: Maps,
) {
  for (const threadId of yield* maps.placeholderThreads) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => undefined));
    // A failed read keeps the map: it is not known to be deleted.
    if (shell === null || (shell !== undefined && shell.deletedAt !== null)) {
      yield* maps.forgetPlaceholders(threadId);
    }
  }
});

export const forgetOnDeletion = (threads: Threads, maps: Maps) =>
  Stream.runForEach(threads.streamDomainEvents, (event) =>
    event.type === "thread.deleted" ? maps.forgetPlaceholders(event.threadId) : Effect.void,
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("placeholder cleanup event stream failed", { cause }),
    ),
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Orchestrator.OrchestratorV2;
    const maps = yield* AgentdPluginsService;
    yield* forkParked(forgetOnDeletion(threads, maps));
    yield* forkParked(forgetDeletedThreads(threads, maps));
  }),
);
