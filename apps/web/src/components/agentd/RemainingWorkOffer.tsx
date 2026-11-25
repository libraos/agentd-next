import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { use } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { TimelineRowActivityCtx } from "../chat/timelineRowContext";
import { Button } from "../ui/button";
import { useCloudWorkersLinked } from "./AgentdIndicator";
import { remainingWorkOffer } from "./agentdVisibility.logic";
import { openStartTaskDialog, useCanStartTask } from "./StartTaskDialog";
import { EMPTY_TASK_FIELDS, TASK_TEXT_LIMIT } from "./startTask.logic";
import { useTaskDirectory } from "./taskPlan";
import { useAgentdState } from "./WorkerReadiness";

// Turns whose offer was answered with Keep in chat, by thread and message.
const keptInChat = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:remaining-work-kept-in-chat"),
);

/**
 * Under a finished turn whose agent said work is left: Run locally or Run in cloud open Hand to a
 * worker with that work as the goal; nothing starts until the person starts it there.
 */
export function RemainingWorkOffer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly runId: RunId | null | undefined;
  /** The final assistant message as stored, status line included. */
  readonly finalMessage: string;
}) {
  const activity = use(TimelineRowActivityCtx);
  // Only the latest idle turn gets past here, so older turns never read agentd.
  if (props.runId == null || props.runId !== activity.latestRunId) return null;
  if (activity.isWorking || activity.awaitingUser) return null;
  return <RemainingWorkOfferCard {...props} />;
}

function RemainingWorkOfferCard({
  threadRef,
  messageId,
  finalMessage,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly finalMessage: string;
}) {
  const gt = useGT();
  const { environmentId } = threadRef;
  const key = `${scopedThreadKey(threadRef)}:${messageId}`;
  const dismissed = useAtomValue(keptInChat)[key] === true;
  const suggestWorkers = useClientSettings((settings) => settings.agentdSuggestWorkers);
  const agentd = useAgentdState(environmentId);
  const agentdSetUp = agentd.state === "on" || agentd.state === "attention";
  const canStartTask = useCanStartTask(environmentId);
  const cloudLinked = useCloudWorkersLinked(agentdSetUp ? environmentId : null);
  const { cwd } = useTaskDirectory(threadRef);
  const offer = remainingWorkOffer({
    finalMessage,
    latestTurn: true,
    turnRunning: false,
    awaitingUser: false,
    suggestWorkers,
    agentdSetUp,
    canStartTask,
    hasWorkingDirectory: cwd !== null,
    dismissed,
    cloudLinked: cloudLinked === true,
  });
  if (offer === null) return null;

  const run = (runOn: "local" | "cloud") =>
    openStartTaskDialog(
      threadRef,
      { ...EMPTY_TASK_FIELDS, goal: offer.remaining.slice(0, TASK_TEXT_LIMIT) },
      { runOn, suggestCheck: true },
    );

  return (
    <section
      aria-label={gt("Work left")}
      className="mt-2 space-y-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="space-y-0.5">
        <p className="font-medium">
          <T>The agent says work is left</T>
        </p>
        {offer.remaining === "" ? null : (
          <p className="wrap-anywhere text-muted-foreground text-xs">{offer.remaining}</p>
        )}
        <p className="text-muted-foreground text-xs">
          <T>Hand it to a worker, or keep going in this chat. Nothing starts until you confirm.</T>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={() => run("local")}>
          <T>Run locally</T>
        </Button>
        {offer.cloud ? (
          <Button size="xs" variant="outline" onClick={() => run("cloud")}>
            <T>Run in cloud</T>
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            appAtomRegistry.set(keptInChat, { ...appAtomRegistry.get(keptInChat), [key]: true })
          }
        >
          <T>Keep in chat</T>
        </Button>
      </div>
    </section>
  );
}
