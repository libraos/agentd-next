import { useAtomValue } from "@effect/atom-react";
import {
  AgentdHandoffId,
  type AgentdTaskRow,
  type RepositoryIdentity,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { T, Var, useGT, useMessages } from "gt-react";
import { LayersIcon, SquareIcon, TerminalSquareIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { agentdTaskBelongsToProject, isFinishedAgentdTask } from "../agentd/backgroundTasks.logic";
import { useNowSecond } from "../../hooks/useNowSecond";
import {
  agentdEnvironment,
  useAgentdCommands,
  useAgentdTask,
  useAgentdTasks,
} from "../../lib/agentdState";
import { ensureLocalApi } from "../../localApi";
import { useQuietThreadProjection } from "../../state/entities";
import { deriveThreadPendingBackgroundTasks } from "../ChatView.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { openBackgroundTasks } from "./useRightPanelActions";

const MAX_RUNNING_TASKS = 5;
const isHandoffId = Schema.is(AgentdHandoffId);

export function LiveDuration({ startedAt }: { startedAt: number }) {
  const messages = useMessages();
  return formatDuration(Math.max(1_000, useNowSecond() - startedAt), messages);
}

function RunningTaskRow({
  goal,
  startedAt,
  onOpen,
  stop,
}: {
  goal: string;
  startedAt: number | null;
  onOpen: () => void;
  stop?: ReactNode;
}) {
  return (
    <div className="flex items-center">
      <div className="min-w-0 flex-1">
        <ThreadDetailsControl onClick={onOpen}>
          <TerminalSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{goal}</span>
          {startedAt !== null ? (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              <LiveDuration startedAt={startedAt} />
            </span>
          ) : null}
        </ThreadDetailsControl>
      </div>
      {stop}
    </div>
  );
}

function AgentdRunningTaskRow({
  row,
  threadRef,
  onOpen,
}: {
  row: AgentdTaskRow;
  threadRef: ScopedThreadRef;
  onOpen: () => void;
}) {
  const gt = useGT();
  const { environmentId } = threadRef;
  const id = isHandoffId(row.id) ? row.id : null;
  const { data: task } = useAgentdTask(id, environmentId);
  const canStop = useAtomValue(agentdEnvironment.stopTask.permissionAtom(environmentId));
  const { stopTask } = useAgentdCommands();
  const [stopping, setStopping] = useState(false);
  const goal = task?.goal.trim() || row.title || row.id;
  const startedAt = Date.parse(row.started ?? task?.started ?? "");

  const confirmStop = () => {
    if (id === null || !canStop || stopping) return;
    setStopping(true);
    void ensureLocalApi()
      .dialogs.confirm(gt("Stop this background task?\n{goal}", { goal }), {
        variant: "destructive",
      })
      .then((confirmed) => {
        if (confirmed) {
          return stopTask({
            environmentId,
            input: { id, reason: gt("Stopped from the session panel.") },
          });
        }
      })
      .finally(() => setStopping(false));
  };

  return (
    <RunningTaskRow
      goal={goal}
      startedAt={Number.isFinite(startedAt) ? startedAt : null}
      onOpen={onOpen}
      stop={
        id !== null && canStop ? (
          <ThreadDetailsControl
            part="icon"
            tone="destructive"
            disabled={stopping}
            aria-label={gt("Stop {goal}", { goal })}
            onClick={confirmStop}
          >
            <SquareIcon className="size-2.5 fill-current" aria-hidden />
          </ThreadDetailsControl>
        ) : null
      }
    />
  );
}

export function ThreadDetailsBackgroundTasks({
  threadRef,
  repositoryIdentity,
  workspaceRoot,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly workspaceRoot: string | null;
}) {
  const gt = useGT();
  const headingId = useId();
  const { data: tasks, failure } = useAgentdTasks(threadRef.environmentId);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const commands = deriveThreadPendingBackgroundTasks(projection)
    .filter(
      (task) =>
        task.kind === "command" &&
        (task.sourceThreadId === undefined || task.sourceThreadId === threadRef.threadId),
    )
    .slice(0, MAX_RUNNING_TASKS);
  const repository =
    repositoryIdentity?.canonicalKey.toLowerCase().match(/^github\.com\/([^/]+\/[^/]+)$/)?.[1] ??
    null;
  const running: AgentdTaskRow[] = [];
  let finished = 0;
  for (const task of tasks ?? []) {
    if (!agentdTaskBelongsToProject(task, workspaceRoot, repository)) continue;
    if (isFinishedAgentdTask(task.state)) finished += 1;
    else if (task.workerRunning && running.length + commands.length < MAX_RUNNING_TASKS)
      running.push(task);
  }

  const openPane = () => {
    openBackgroundTasks(threadRef);
  };

  return (
    <ThreadDetailsSection headingId={headingId} title={gt("Background tasks")} showHeading={false}>
      <div>
        <h3 className="mb-1 px-2.5 text-2xs font-medium text-muted-foreground">
          <button
            type="button"
            className="min-h-8 cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-ring"
            onClick={openPane}
          >
            <T>Background tasks</T>
          </button>
        </h3>
        {commands.map((task) => {
          const startedAt = projection?.turnItems.findLast(
            (item) =>
              item.type === "command_execution" &&
              (task.itemId !== undefined
                ? item.id === task.itemId
                : (item.nativeItemRef?.nativeId ?? item.id) === task.taskId),
          )?.startedAt;
          return (
            <RunningTaskRow
              key={`command:${task.taskId}`}
              goal={task.description ?? task.command ?? task.taskId}
              startedAt={startedAt ? DateTime.toEpochMillis(startedAt) : null}
              onOpen={openPane}
            />
          );
        })}
        {running.map((row) => (
          <AgentdRunningTaskRow key={row.id} row={row} threadRef={threadRef} onOpen={openPane} />
        ))}
        {failure !== null ? (
          <div className="px-2.5 text-xs text-muted-foreground">
            {failure._tag === "AgentdNotFoundError" ? (
              <T>LibraOS Engine was not found.</T>
            ) : (
              <T>LibraOS Engine tasks are unavailable.</T>
            )}
          </div>
        ) : tasks !== null ? (
          <ThreadDetailsControl tone="muted" onClick={openPane}>
            <LayersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <T>
              <Var>{finished}</Var> finished
            </T>
          </ThreadDetailsControl>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
