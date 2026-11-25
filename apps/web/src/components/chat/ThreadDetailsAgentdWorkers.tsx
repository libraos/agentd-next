import { type AgentdTaskRow, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import { BotIcon, ListIcon, UserPlusIcon } from "lucide-react";
import { useId } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useAgentdTasks } from "../../lib/agentdState";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { groupWorkerActivity } from "../agentd/AgentdPage.logic";
import { openStartTaskDialog, useCanStartTask } from "../agentd/StartTaskDialog";
import { LiveDuration } from "./ThreadDetailsBackgroundTasks";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { openBackgroundTasks } from "./useRightPanelActions";

const MAX_WORKERS = 5;

function WorkerRow({ row, onOpen }: { row: AgentdTaskRow; onOpen: () => void }) {
  const blocked = row.workerState === "blocked";
  const startedAt = Date.parse(row.started ?? "");
  const who = [row.workerTool, row.runsOn === "local" ? null : row.workerName]
    .filter(Boolean)
    .join(" · ");
  return (
    <ThreadDetailsControl onClick={onOpen} multiline>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 self-start rounded-full",
          blocked ? "bg-warning" : "bg-success",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{row.title || row.id}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {who ? `${who} · ` : null}
          {blocked ? <T>Waiting for input</T> : <T>Running</T>}
        </span>
      </span>
      {Number.isFinite(startedAt) ? (
        <span className="shrink-0 self-start text-2xs text-muted-foreground tabular-nums">
          <LiveDuration startedAt={startedAt} />
        </span>
      ) : null}
    </ThreadDetailsControl>
  );
}

/** Every agentd worker running now, on this machine, the team and the cloud. */
export function ThreadDetailsAgentdWorkers({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const headingId = useId();
  const navigate = useNavigate();
  const { data: tasks, failure } = useAgentdTasks(threadRef.environmentId);
  const runTasksOn = useClientSettings((settings) => settings.agentdRunTasksOn);
  const canStartTask = useCanStartTask(threadRef.environmentId);
  const activity = groupWorkerActivity(tasks ?? [], []);
  const workers = [
    ...activity.local,
    ...activity.team.flatMap((node) => node.tasks),
    ...activity.cloud,
  ];

  const openWorker = (row: AgentdTaskRow) => {
    openBackgroundTasks(threadRef);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      hash: `agentd-task-${row.id}`,
      replace: true,
    });
  };

  return (
    <ThreadDetailsSection
      headingId={headingId}
      title={gt("LibraOS Engine workers")}
      showHeading={false}
    >
      <div>
        <h3 className="mb-1 px-2.5 text-2xs font-medium text-muted-foreground">
          <button
            type="button"
            className="min-h-8 cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-ring"
            onClick={() => void navigate({ to: "/agentd" })}
          >
            <T>LibraOS Engine workers</T>
          </button>
          <span className="ms-1.5 font-normal">
            {runTasksOn === "cloud" ? <T>cloud</T> : <T>this machine</T>}
          </span>
        </h3>
        {workers.slice(0, MAX_WORKERS).map((row) => (
          <WorkerRow key={row.id} row={row} onOpen={() => openWorker(row)} />
        ))}
        {failure !== null ? (
          <div className="px-2.5 text-xs text-muted-foreground">
            {failure._tag === "AgentdNotFoundError" ? (
              <T>LibraOS Engine was not found.</T>
            ) : (
              <T>LibraOS Engine tasks are unavailable.</T>
            )}
          </div>
        ) : tasks === null ? null : workers.length === 0 ? (
          <ThreadDetailsControl tone="muted" onClick={() => void navigate({ to: "/agentd" })}>
            <BotIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <T>No workers running</T>
          </ThreadDetailsControl>
        ) : workers.length > MAX_WORKERS ? (
          <ThreadDetailsControl tone="muted" onClick={() => void navigate({ to: "/agentd" })}>
            <ListIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <T>
              <Var>{workers.length - MAX_WORKERS}</Var> more
            </T>
          </ThreadDetailsControl>
        ) : null}
        {canStartTask ? (
          <ThreadDetailsControl onClick={() => openStartTaskDialog(threadRef)}>
            <UserPlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <T>Hand to a worker</T>
          </ThreadDetailsControl>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
