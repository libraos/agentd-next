import type {
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

export function runningAgentdTaskLabel(
  {
    state,
    workerState,
    workerRunning,
  }: Pick<AgentdTaskRow, "state" | "workerState" | "workerRunning">,
  budgetState: string | null,
  resolve: MessageResolver = m,
): string {
  if (
    workerState === "blocked" ||
    workerState === "waiting_answer" ||
    budgetState === "budget_exceeded"
  ) {
    return resolve(msg("Waiting for a person"));
  }
  if (workerState === "gone") return resolve(msg("Worker exited"));
  if (workerState === "stopped" || budgetState === "stopped") return resolve(msg("Worker stopped"));
  if (workerRunning) return resolve(msg("Running", { $context: "status of background work" }));
  if (state === "blocked") return resolve(msg("Waiting for other tasks"));
  if (state === "offered") return resolve(msg("Queued", { $context: "status of background work" }));
  if (state === "held") return resolve(msg("On hold", { $context: "status of background work" }));
  return resolve(msg("Assigned", { $context: "status of background work" }));
}

function isFailedAgentdTask(
  state: string,
  verdict: Pick<AgentdTaskVerdict, "check"> | null,
): boolean {
  return state === "declined" || /^(?:failed|timed_out)(?=:|\s|$)/.test(verdict?.check ?? "");
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
