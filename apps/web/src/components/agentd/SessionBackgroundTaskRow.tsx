import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  AgentdTaskRow,
  OrchestrationV2PendingBackgroundTask,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";

import { CommandOutputPanel } from "../chat/CommandOutputPanel";
import { ShellCommandBlock } from "../chat/ShellCommandBlock";
import { AgentdTaskOutput } from "./AgentdTaskOutput";
import { BackgroundTaskCard } from "./BackgroundTaskCard";
import { handoffIdsInCommand, runningAgentdTaskLabel } from "./backgroundTasks.logic";

export function SessionBackgroundTaskRow(props: {
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly threadRef: ScopedThreadRef;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly streamsOutput: boolean;
  readonly agentdRows: readonly AgentdTaskRow[];
}) {
  const { task, threadRef, turnItems, streamsOutput, agentdRows } = props;
  const gt = useGT();
  const resolve = useMessages();
  const item = turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const live = itemId !== undefined && streamsOutput && item?.status === "running";
  // A wait on an agentd task shows that task's progress, so the row never looks stuck.
  const waitedOn = handoffIdsInCommand(command).map(
    (id) => agentdRows.find((row) => row.id === id) ?? id,
  );

  return (
    <BackgroundTaskCard
      title={task.description?.trim() || command || gt("Background work")}
      summary={
        <>
          <span className="font-medium text-foreground">
            {waitedOn.length > 0 ? (
              <T>Waiting for a LibraOS Core worker</T>
            ) : (
              <T $context="status of background work">Running</T>
            )}
          </span>
          {waitedOn.map((row) =>
            typeof row === "string" ? null : (
              <span key={row.id}>{runningAgentdTaskLabel(row, null, resolve)}</span>
            ),
          )}
          <span>
            <T>This session</T>
          </span>
        </>
      }
    >
      {command ? (
        <div className="font-mono wrap-anywhere whitespace-pre-wrap select-text">
          <ShellCommandBlock command={command} />
        </div>
      ) : null}
      {waitedOn.map((row) =>
        typeof row === "string" ? (
          <p key={row} className="text-muted-foreground">
            <T>
              Waiting for LibraOS Core task <Var>{row}</Var>.
            </T>
          </p>
        ) : (
          <div key={row.id} className="space-y-1">
            <p className="wrap-anywhere text-muted-foreground">
              <T>
                Worker: <Var>{row.title || row.id}</Var>
              </T>
            </p>
            <AgentdTaskOutput id={row.id} environmentId={threadRef.environmentId} />
          </div>
        ),
      )}
      {live ? (
        <div className="font-mono wrap-anywhere whitespace-pre-wrap select-text">
          <CommandOutputPanel
            environmentId={threadRef.environmentId}
            threadId={task.sourceThreadId ?? item?.threadId ?? threadRef.threadId}
            itemId={itemId}
          />
        </div>
      ) : waitedOn.length > 0 ? null : (
        <p className="text-muted-foreground">
          <T>Running. The agent reads this command&apos;s output when it finishes.</T>
        </p>
      )}
    </BackgroundTaskCard>
  );
}
