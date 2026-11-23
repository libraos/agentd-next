import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import type { AgentdRunsOn, AgentdTask, AgentdTaskRow, EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { agentdEnvironment, useAgentdCommands, useAgentdTask } from "../../lib/agentdState";
import { tickTextContent } from "../../lib/tickTextContent";
import { formatEnvironmentQueryError } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentdTaskOutput } from "./AgentdTaskOutput";
import { BackgroundTaskCard } from "./BackgroundTaskCard";
import { CloudTaskReviewActions } from "./CloudTaskReview";
import {
  agentdTaskBudgetUse,
  type AgentdTaskBudgetTone,
  finishedAgentdTaskLabel,
  runningAgentdTaskLabel,
} from "./backgroundTasks.logic";
import { budgetDollarLimit, budgetMinutes } from "./startTask.logic";

function AgentdTaskLocation({ location }: { readonly location: AgentdRunsOn }) {
  switch (location) {
    case "local":
      return <T>Local worker</T>;
    case "team":
      return <T>Team node</T>;
    case "cloud":
      return <T>Cloud Worker</T>;
  }
}

function workerName(tool: string | null): string | null {
  switch (tool) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "opencode";
    default:
      return tool;
  }
}

function TaskDuration(props: {
  readonly started: string | null;
  readonly ended: string | null;
  readonly live: boolean;
}) {
  const resolve = useMessages();
  const started = Date.parse(props.started ?? "");
  const ended = Date.parse(props.ended ?? "");
  if (!Number.isFinite(started) || (!props.live && !Number.isFinite(ended))) {
    return (
      <span>
        <T>Duration unavailable</T>
      </span>
    );
  }
  const format = (now: number) => formatDuration(Math.max(0, now - started), resolve);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        {props.live ? <span ref={tickTextContent(format, true)} /> : format(ended)}
      </TooltipTrigger>
      <TooltipPopup>
        {props.live ? (
          <T>Time since the task was created</T>
        ) : (
          <T>Time from task creation to last update</T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

function TaskCost({ task }: { readonly task: AgentdTask }) {
  const locale = useLocale();
  if (task.costUsd === null) return <T>Cost unavailable</T>;
  const cost = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(task.costUsd);
  return task.costEstimate ? (
    <T>
      Estimated cost: <Var>{cost}</Var>
    </T>
  ) : (
    <T>
      Cost: <Var>{cost}</Var>
    </T>
  );
}

const BUDGET_TONE: Record<AgentdTaskBudgetTone, string> = {
  progress: "bg-primary",
  warning: "bg-warning",
  success: "bg-success",
  failure: "bg-destructive",
};

/** The task's elapsed time, ticking each second while it runs. */
function useElapsedMs(task: AgentdTask | null, live: boolean): number {
  const now = useSyncExternalStore(
    (listener) => (live ? secondTick.subscribe(listener) : () => {}),
    () => (live ? Math.floor(Date.now() / 1000) * 1000 : 0),
  );
  const started = Date.parse(task?.started ?? "");
  if (!Number.isFinite(started)) return 0;
  const ended = live ? now : Date.parse(task?.updated ?? "");
  return Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

function TaskBudgetBar(props: {
  readonly task: AgentdTask;
  readonly finished: boolean;
  readonly elapsedMs: number;
}) {
  const gt = useGT();
  const { task, finished, elapsedMs } = props;
  const use = agentdTaskBudgetUse({
    budget: task.budget,
    elapsedMs,
    costUsd: task.costUsd,
    finished,
    state: task.state,
    verdict: task.verdict,
    budgetState: task.budgetState,
  });
  if (use === null) return null;
  const percent = Math.round(use.fraction * 100);
  return (
    <span className="flex basis-full items-center gap-1.5 pt-0.5">
      <span
        role="progressbar"
        aria-label={gt("Budget used")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full ${BUDGET_TONE[use.tone]}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      {use.tone === "success" ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-success" />
      ) : null}
    </span>
  );
}

function TaskBudgetDetails(props: {
  readonly task: AgentdTask;
  readonly finished: boolean;
  readonly elapsedMs: number;
}) {
  const locale = useLocale();
  const resolve = useMessages();
  const { task, finished, elapsedMs } = props;
  const minutes = budgetMinutes(task.budget);
  const dollars = budgetDollarLimit(task.budget);
  if (!minutes && !dollars) return null;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const used = formatDuration(elapsedMs, resolve);
  return (
    <dl className="space-y-2 wrap-anywhere select-text">
      <div>
        <dt className="font-medium">
          <T>Budget used</T>
        </dt>
        <dd className="text-muted-foreground tabular-nums">
          {minutes ? (
            <span className="block">
              <T>
                Time: <Var>{used}</Var> of <Var>{minutes}</Var> min
              </T>
            </span>
          ) : null}
          {dollars ? (
            <span className="block">
              {task.costUsd === null ? (
                <T>
                  Budget: <Var>{money.format(dollars)}</Var>
                </T>
              ) : task.costEstimate ? (
                <T>
                  Estimated cost: <Var>{money.format(task.costUsd)}</Var> of{" "}
                  <Var>{money.format(dollars)}</Var>
                </T>
              ) : (
                <T>
                  Cost: <Var>{money.format(task.costUsd)}</Var> of{" "}
                  <Var>{money.format(dollars)}</Var>
                </T>
              )}
            </span>
          ) : null}
        </dd>
      </div>
      {!finished && task.report ? (
        <div>
          <dt className="font-medium">
            <T>Latest report</T>
          </dt>
          <dd className="whitespace-pre-wrap text-muted-foreground">{task.report}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function FinishedTaskDetails({ task }: { readonly task: AgentdTask }) {
  return (
    <dl className="space-y-2 wrap-anywhere select-text">
      <div>
        <dt className="font-medium">
          <T>Check result</T>
        </dt>
        <dd className="whitespace-pre-wrap text-muted-foreground">
          {task.verdict?.check ?? <T>No check result was recorded.</T>}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <T>Next step</T>
        </dt>
        <dd className="whitespace-pre-wrap text-muted-foreground">
          {task.verdict?.next ?? <T>No next step was recorded.</T>}
        </dd>
      </div>
    </dl>
  );
}

export function StopTaskButton(props: {
  readonly id: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
}) {
  const { environmentId, id, title } = props;
  const gt = useGT();
  const resolve = useMessages();
  const canStop = useAtomValue(agentdEnvironment.stopTask.permissionAtom(environmentId));
  const { stopTask } = useAgentdCommands();
  const [status, setStatus] = useState<"idle" | "pending" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!canStop) return null;

  const stop = async () => {
    setStatus("pending");
    setError(null);
    const confirmed = await requestConfirmDialog(
      gt("Stop this background task?\n{title}", { title }),
      { variant: "destructive" },
    );
    if (confirmed !== true) {
      setStatus("idle");
      return;
    }
    const result = await stopTask({
      environmentId,
      input: { id, reason: "Stopped from AgentD Next" },
    });
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause, resolve));
      setStatus("idle");
      return;
    }
    setStatus("requested");
  };

  return (
    <>
      <Button size="xs" variant="ghost-destructive" disabled={status !== "idle"} onClick={stop}>
        {status === "requested" ? <T>Stop requested</T> : <T>Stop</T>}
      </Button>
      {error ? (
        <p className="max-w-32 wrap-anywhere text-xs text-destructive" role="alert">
          <T>
            Couldn&apos;t stop task: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
    </>
  );
}

export function useAgentdTaskDetails(row: AgentdTaskRow, environmentId: EnvironmentId | null) {
  const { data, error, refresh } = useAgentdTask(row.id, environmentId);
  const task = data?.state === row.state ? data : null;
  const snapshot = JSON.stringify([
    row.state,
    row.updated,
    row.workerState,
    row.workerRunning,
    row.cloudState,
    row.cloudUsd,
  ]);
  const lastSnapshot = useRef(data !== null && task === null ? null : snapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh bridge-only fields when the live list changes for this task
  useEffect(() => {
    if (lastSnapshot.current === snapshot) return;
    lastSnapshot.current = snapshot;
    refresh();
  }, [refresh, snapshot]);

  return { task, error };
}

function CloudState({ state }: { readonly state: string | null }) {
  switch (state) {
    case "submitting":
      return <T>Submitting</T>;
    case "queued":
      return <T>Queued</T>;
    case "running":
      return <T>Running</T>;
    case "settling":
      return <T>Settling</T>;
    case "completed":
      return <T>Completed</T>;
    case "failed":
      return <T>Failed</T>;
    case "failed_verification":
      return <T>Failed verification</T>;
    case "cancelled":
      return <T>Stopped</T>;
    case "budget_exceeded":
      return <T>Budget exceeded</T>;
    default:
      return state ?? <T>Status unavailable</T>;
  }
}

export function AgentdCloudTaskSummary({
  row,
  task,
}: {
  readonly row: AgentdTaskRow;
  readonly task: AgentdTask | null;
}) {
  const locale = useLocale();
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const cloud = task?.cloud;
  const state = row.cloudState ?? cloud?.state ?? row.workerState;
  const total = row.cloudUsd ?? cloud?.totalUsd;
  const branch = task?.branch ?? row.branch;
  return (
    <>
      <Badge variant="secondary">
        <AgentdTaskLocation location="cloud" />
      </Badge>
      <span className="font-medium text-foreground">
        <CloudState state={state} />
      </span>
      {cloud?.modelAccess === "subscription" ? (
        <span>
          {cloud.plan === "codex" ? (
            <T>Your ChatGPT subscription</T>
          ) : (
            <T>Your Claude subscription</T>
          )}
        </span>
      ) : cloud?.modelAccess === "byok" ? (
        <span>
          <T>Your API key</T>
        </span>
      ) : cloud?.modelAccess === "libraos" ? (
        <span>LibraOS</span>
      ) : null}
      {cloud?.workerUsd != null ? (
        <span>
          <T>
            Worker cost: <Var>{format.format(cloud.workerUsd)}</Var>
          </T>
        </span>
      ) : null}
      {cloud?.modelAccess === "subscription" ? (
        <span>
          {cloud.plan === "codex" ? (
            <T>Inference: billed to your ChatGPT plan</T>
          ) : (
            <T>Inference: billed to your Claude plan</T>
          )}
        </span>
      ) : cloud?.modelAccess === "byok" ? (
        <span>
          <T>Inference: billed by your provider</T>
        </span>
      ) : cloud?.inferenceUsd != null ? (
        <span>
          <T>
            Inference: <Var>{format.format(cloud.inferenceUsd)}</Var>
          </T>
        </span>
      ) : null}
      {total != null ? (
        <span>
          <T>
            Total (LibraOS): <Var>{format.format(total)}</Var>
          </T>
        </span>
      ) : null}
      {branch ? (
        <span className="min-w-0 wrap-anywhere">
          <T>
            Branch: <Var>{branch}</Var>
          </T>
        </span>
      ) : null}
    </>
  );
}

export function AgentdBackgroundTaskRow(props: {
  readonly row: AgentdTaskRow;
  readonly environmentId: EnvironmentId;
  readonly finished: boolean;
}) {
  const { row, environmentId, finished } = props;
  const gt = useGT();
  const resolve = useMessages();
  const { task, error } = useAgentdTaskDetails(row, environmentId);

  const title = task?.goal?.trim() || row.title || gt("Untitled task");
  const worker = workerName(task?.workerTool ?? row.workerTool);
  const location = task?.runsOn ?? (row.runsOn === "cloud" ? row.runsOn : null);
  const cloud = location === "cloud";
  const elapsedMs = useElapsedMs(task, !finished);
  return (
    <BackgroundTaskCard
      title={title}
      summary={
        <>
          {cloud ? (
            <AgentdCloudTaskSummary row={row} task={task} />
          ) : (
            <span className="font-medium text-foreground">
              {finished
                ? finishedAgentdTaskLabel(row.state, task?.verdict ?? null, resolve)
                : runningAgentdTaskLabel(row, task?.budgetState ?? null, resolve)}
            </span>
          )}
          {!finished && (!cloud || worker !== null) ? (
            <span>{worker ?? <T>Agent unknown</T>}</span>
          ) : null}
          {location === null || cloud ? null : (
            <span>
              <AgentdTaskLocation location={location} />
            </span>
          )}
          {task !== null || error !== null ? (
            <TaskDuration
              started={task?.started ?? null}
              ended={task?.updated ?? null}
              live={!finished}
            />
          ) : null}
          {finished && task && !cloud ? (
            <>
              <span className="min-w-0 wrap-anywhere">
                {task.branch ? (
                  <T>
                    Branch: <Var>{task.branch}</Var>
                  </T>
                ) : (
                  <T>Branch unavailable</T>
                )}
              </span>
              <span>
                <TaskCost task={task} />
              </span>
            </>
          ) : null}
          {cloud && task?.note ? (
            <span className="basis-full wrap-anywhere text-destructive">{task.note}</span>
          ) : null}
          {task && !cloud ? (
            <TaskBudgetBar task={task} finished={finished} elapsedMs={elapsedMs} />
          ) : null}
        </>
      }
      action={
        !finished ? (
          <StopTaskButton id={row.id} title={title} environmentId={environmentId} />
        ) : cloud ? (
          <CloudTaskReviewActions row={row} task={task} environmentId={environmentId} />
        ) : null
      }
    >
      {error ? (
        <p className="text-destructive" role="alert">
          <T>
            Couldn&apos;t load task details: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
      {task && !cloud ? (
        <TaskBudgetDetails task={task} finished={finished} elapsedMs={elapsedMs} />
      ) : null}
      {finished ? (
        task ? (
          <FinishedTaskDetails task={task} />
        ) : error === null ? (
          <T>Loading task details…</T>
        ) : null
      ) : (
        <AgentdTaskOutput
          id={task?.hasLog === false ? null : row.id}
          environmentId={environmentId}
        />
      )}
    </BackgroundTaskCard>
  );
}
