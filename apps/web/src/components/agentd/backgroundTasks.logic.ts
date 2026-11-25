import type {
  AgentdApproval,
  AgentdTask,
  AgentdTaskRow,
  AgentdTaskVerdict,
  EnvironmentId,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { budgetDollarLimit, budgetMinutes } from "./startTask.logic";

function comparablePath(path: string): string {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  // Windows paths compare without case; a drive letter or a UNC prefix marks one.
  return /^([A-Za-z]:|\/\/)/u.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * Whether a task belongs to a project: its checkout is the project's folder or inside it,
 * else (no checkout reported) its agentd project names the project's repository.
 */
export function agentdTaskBelongsToProject(
  task: Pick<AgentdTaskRow, "workerCwd" | "project">,
  workspaceRoot: string | null,
  repository: string | null,
): boolean {
  if (task.workerCwd && workspaceRoot) {
    const cwd = comparablePath(task.workerCwd);
    const root = comparablePath(workspaceRoot);
    return cwd === root || cwd.startsWith(`${root}/`);
  }
  return repository !== null && task.project?.toLowerCase() === repository;
}

/**
 * A git checkout in the environment whose origin is the cloud task's GitHub repository, where its
 * branch can be fetched and compared; null when none is, such as a folder workspace without git.
 */
export function cloudReviewCheckout(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
    readonly archivedAt?: string | null | undefined;
  }>,
  environmentId: EnvironmentId,
  repository: string | null,
): string | null {
  if (repository === null) return null;
  const wanted = `github.com/${repository.toLowerCase()}`;
  const match = projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (project.environmentId !== environmentId || !identity || project.archivedAt) return false;
    // The origin decides, as for the cloud offer: a fork's identity may name its upstream.
    return (identity.origin?.canonicalKey ?? identity.canonicalKey).toLowerCase() === wanted;
  });
  return match?.workspaceRoot ?? null;
}

export function isFinishedAgentdTask(state: string): boolean {
  return state === "done" || state === "delivered" || state === "cancelled" || state === "declined";
}

export function isQueuedAgentdTask(
  row: Pick<AgentdTaskRow, "state" | "workerRunning" | "workerState" | "runsOn" | "a2aState">,
): boolean {
  return (
    row.state === "offered" &&
    !row.workerRunning &&
    row.runsOn !== "cloud" &&
    !row.workerState &&
    (row.a2aState == null || row.a2aState === "submitted")
  );
}

function needsPerson(
  { a2aState, workerState }: Pick<AgentdTaskRow, "a2aState" | "workerState">,
  budgetState: string | null | undefined,
): boolean {
  return (
    a2aState === "auth-required" ||
    a2aState === "input-required" ||
    a2aState === "failed" ||
    workerState === "blocked" ||
    workerState === "suspect" ||
    workerState === "waiting_answer" ||
    budgetState === "budget_exceeded"
  );
}

function isWaitingAgentdTask(
  row: Pick<AgentdTaskRow, "state" | "workerState" | "runsOn" | "a2aState">,
  budgetState?: string | null,
): boolean {
  return (
    row.runsOn !== "cloud" &&
    (needsPerson(row, budgetState) ||
      budgetState === "stopped" ||
      row.workerState === "stopped" ||
      row.workerState === "gone" ||
      row.state === "held" ||
      row.state === "checkpoint" ||
      row.state === "blocked")
  );
}

/** The pending approvals agentd holds for a task: those whose handoff is the task's id. */
export function agentdTaskApprovals<Approval extends Pick<AgentdApproval, "handoff">>(
  approvals: ReadonlyArray<Approval>,
  id: string,
): Approval[] {
  return approvals.filter((approval) => approval.handoff === id);
}

export type AgentdTaskSection = "running" | "queued" | "waiting" | "finished";

/** The Background tasks section a task is listed under; a pending approval needs a person. */
export function agentdTaskSection(
  status: Pick<
    AgentdTaskRow,
    "id" | "state" | "workerState" | "workerRunning" | "runsOn" | "a2aState"
  >,
  details: Pick<AgentdTask, "parked" | "budgetState"> | null,
  approvals: ReadonlyArray<Pick<AgentdApproval, "handoff">>,
): AgentdTaskSection {
  if (isFinishedAgentdTask(status.state)) return "finished";
  if (
    details?.parked ||
    isWaitingAgentdTask(status, details?.budgetState) ||
    (status.runsOn !== "cloud" && agentdTaskApprovals(approvals, status.id).length > 0)
  ) {
    return "waiting";
  }
  return isQueuedAgentdTask(status) ? "queued" : "running";
}

export function queuedAgentdTaskReason(
  worker: string | null,
  pickup?: AgentdTask["queuePickup"],
  resolve: MessageResolver = m,
): string {
  if (pickup === "recipient") return resolve(msg("Waiting for the recipient to pick up this task"));
  if (pickup === "remote") return resolve(msg("Waiting for a remote worker"));
  return worker === null
    ? resolve(msg("Won't start on its own: no agent chosen"))
    : resolve(msg("Waiting for a {worker} worker"), { worker });
}

export function queueBlockLabel(reason: string, resolve: MessageResolver): string {
  const details = reason.slice(reason.indexOf(":") + 1).trim();
  if (reason.startsWith("spec before code:")) {
    return resolve(msg("Needs a specification: {details}"), { details });
  }
  if (reason.startsWith("project concurrency limit:")) {
    return resolve(msg("Reached the project’s concurrent task limit: {details}"), { details });
  }
  if (reason.startsWith("person concurrency limit:")) {
    return resolve(msg("Reached the person’s concurrent task limit: {details}"), { details });
  }
  return reason;
}

export function queuedAgentdTaskWait(
  created: string | null,
  now: number,
  resolve: MessageResolver = m,
): { label: string | null; long: boolean } {
  const elapsed = now - Date.parse(created ?? "");
  if (!Number.isFinite(elapsed)) return { label: null, long: false };
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const long = elapsed > day;
  if (elapsed >= day) {
    return {
      label: resolve(msg("Queued for {count, plural, one {{count} day} other {{count} days}}"), {
        count: Math.floor(elapsed / day),
      }),
      long,
    };
  }
  if (elapsed >= hour) {
    return {
      label: resolve(msg("Queued for {count, plural, one {{count} hour} other {{count} hours}}"), {
        count: Math.floor(elapsed / hour),
      }),
      long,
    };
  }
  if (elapsed >= minute) {
    return {
      label: resolve(
        msg("Queued for {count, plural, one {{count} minute} other {{count} minutes}}"),
        {
          count: Math.floor(elapsed / minute),
        },
      ),
      long,
    };
  }
  return { label: resolve(msg("Queued for less than a minute")), long };
}

export function runningAgentdTaskLabel(
  row: Pick<AgentdTaskRow, "state" | "workerState" | "workerRunning" | "a2aState">,
  budgetState: string | null,
  resolve: MessageResolver = m,
): string {
  const { state, workerState, workerRunning } = row;
  if (needsPerson(row, budgetState)) {
    return resolve(msg("Waiting for a person"));
  }
  if (workerState === "gone") return resolve(msg("Worker exited"));
  if (workerState === "stopped" || budgetState === "stopped") return resolve(msg("Worker stopped"));
  if (workerRunning) return resolve(msg("Running", { $context: "status of background work" }));
  if (state === "blocked") return resolve(msg("Waiting for other tasks"));
  if (state === "offered") return resolve(msg("Queued", { $context: "status of background work" }));
  if (state === "held" || state === "checkpoint")
    return resolve(msg("On hold", { $context: "status of background work" }));
  return resolve(msg("Assigned", { $context: "status of background work" }));
}

function isFailedAgentdTask(
  state: string,
  verdict: Pick<AgentdTaskVerdict, "check"> | null,
): boolean {
  return state === "declined" || /^(?:failed|timed[_ ]out)(?=:|\s|$)/.test(verdict?.check ?? "");
}

/** An unfinished task whose worker exited or whose check failed: its check can be run again. */
export function isStuckAgentdTask(
  task: Pick<AgentdTask, "state" | "workerState" | "verdict" | "runsOn">,
): boolean {
  return (
    task.runsOn !== "cloud" &&
    !isFinishedAgentdTask(task.state) &&
    (task.workerState === "gone" || isFailedAgentdTask(task.state, task.verdict))
  );
}

export function finishedAgentdTaskLabel(
  state: string,
  verdict: Pick<AgentdTaskVerdict, "verdict" | "check"> | null,
  resolve: MessageResolver = m,
): string {
  if (state === "cancelled")
    return resolve(msg("Stopped", { $context: "result of background work" }));
  if (isFailedAgentdTask(state, verdict)) {
    return resolve(msg("Failed", { $context: "result of background work" }));
  }
  if (verdict?.verdict === "verified") {
    return resolve(msg("Verified", { $context: "result of background work" }));
  }
  if (verdict === null) return resolve(msg("Result unavailable"));
  return resolve(msg("Needs work", { $context: "result of background work" }));
}

const BUDGET_WARNING = 0.85;

export type AgentdTaskBudgetTone = "progress" | "warning" | "success" | "failure";

/**
 * How much of its budget a task has used: the larger of time and money, capped at all of it. It is
 * not how much of the work is done. A finished task fills the bar in its result's tone; a task
 * without a budget has none.
 */
export function agentdTaskBudgetUse(input: {
  readonly budget: string | null;
  readonly elapsedMs: number;
  readonly costUsd: number | null;
  readonly finished: boolean;
  readonly state: string;
  readonly verdict: Pick<AgentdTaskVerdict, "verdict" | "check"> | null;
  readonly budgetState: string | null;
}): { readonly fraction: number; readonly tone: AgentdTaskBudgetTone } | null {
  const minutes = budgetMinutes(input.budget);
  const dollars = budgetDollarLimit(input.budget);
  if (!minutes && !dollars) return null;
  if (input.finished) {
    const tone =
      input.state === "cancelled"
        ? "warning"
        : isFailedAgentdTask(input.state, input.verdict)
          ? "failure"
          : input.verdict?.verdict === "verified"
            ? "success"
            : "warning";
    return { fraction: 1, tone };
  }
  const fraction = Math.min(
    1,
    Math.max(
      minutes ? input.elapsedMs / (minutes * 60_000) : 0,
      dollars && input.costUsd !== null ? input.costUsd / dollars : 0,
    ),
  );
  const stopped = input.budgetState === "stopped" || input.budgetState === "budget_exceeded";
  return { fraction, tone: stopped || fraction >= BUDGET_WARNING ? "warning" : "progress" };
}

/** The agentd tasks a session command waits on or reads, e.g. `agentd handoff wait hof-…`. */
export function handoffIdsInCommand(command: string | undefined): readonly string[] {
  return [...new Set(command?.match(/\bhof-[0-9a-f]{6,}\b/gu) ?? [])];
}
