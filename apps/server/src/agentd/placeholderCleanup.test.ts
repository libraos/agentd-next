import { expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forgetDeletedThreads, forgetOnDeletion } from "./placeholderCleanup.ts";

const LIVE = ThreadId.make("live");
const DELETED = ThreadId.make("deleted");
const GONE = ThreadId.make("gone");

const harness = (events: ReadonlyArray<Partial<OrchestrationV2DomainEvent>>) => {
  const forgotten: string[] = [];
  const threads = {
    streamDomainEvents: Stream.fromIterable(events as ReadonlyArray<OrchestrationV2DomainEvent>),
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === GONE ? null : { deletedAt: threadId === DELETED ? "2026-11-23" : null },
      ),
  } as unknown as Parameters<typeof forgetOnDeletion>[0];
  const maps = {
    placeholderThreads: Effect.succeed([LIVE, DELETED, GONE]),
    forgetPlaceholders: (threadId: ThreadId) => Effect.sync(() => void forgotten.push(threadId)),
  };
  return { threads, maps, forgotten };
};

it.effect("a deleted thread's placeholder map is forgotten", () =>
  Effect.gen(function* () {
    const h = harness([
      { type: "thread.deleted", threadId: DELETED },
      { type: "thread.archived" as never, threadId: LIVE },
    ]);
    yield* forgetOnDeletion(h.threads, h.maps);
    expect(h.forgotten).toEqual([DELETED]);
  }),
);

it.effect("at start, maps of threads deleted or gone are forgotten and live ones kept", () =>
  Effect.gen(function* () {
    const h = harness([]);
    yield* forgetDeletedThreads(h.threads, h.maps);
    expect(h.forgotten).toEqual([DELETED, GONE]);
  }),
);
