import type {
  AgentdCloudSetup,
  AgentdRunTasksOn,
  AgentdStatus,
  AgentdTaskRow,
} from "@t3tools/contracts";

import type { taskBranchProblem } from "./startTask.logic";

/** What the sidebar indicator says; `unknown` until agentd first answers, so nothing spins. */
export type AgentdIndicatorState = "unknown" | "not-installed" | "not-set-up" | "attention" | "on";

/** agentd's own answer, kept while a later read is slow or fails. */
export function agentdIndicatorState(
  status: Pick<AgentdStatus, "setUp" | "ok"> | null,
  failureTag: string | null,
): AgentdIndicatorState {
  if (status !== null) {
    if (!status.setUp) return "not-set-up";
    return status.ok ? "on" : "attention";
  }
  if (failureTag === "AgentdNotFoundError") return "not-installed";
  return failureTag === null ? "unknown" : "attention";
}

/** A worker on this machine, a team node or the cloud is working on this project now. */
export function projectHasRunningWorker(
  rows: ReadonlyArray<AgentdTaskRow>,
  belongs: (row: AgentdTaskRow) => boolean,
): boolean {
  return rows.some(
    (row) =>
      (row.workerRunning || (row.runsOn !== "local" && row.state === "claimed")) && belongs(row),
  );
}

export const OFFER_AFTER_MS = 5 * 60_000;

/** The turn has run for five minutes, or the person sent a message while it ran. */
export function workerOfferSignal(input: {
  readonly running: boolean;
  readonly startedAtMs: number | null;
  readonly nowMs: number;
  readonly sentWhileRunning: boolean;
}): boolean {
  if (!input.running) return false;
  if (input.sentWhileRunning) return true;
  return input.startedAtMs !== null && input.nowMs - input.startedAtMs >= OFFER_AFTER_MS;
}

/**
 * Whether a Code thread offers "Hand this to a worker", and where the worker would run. A local
 * worker needs a named branch (on main agentd gives it a new branch in its own worktree); on a
 * detached head the offer names Cloud Workers if the account is linked, else it does not show.
 */
export function workerOffer(input: {
  readonly suggestWorkers: boolean;
  readonly dismissedInThread: boolean;
  readonly signal: boolean;
  readonly codeThread: boolean;
  readonly agentdSetUp: boolean;
  /** Null until the checkout's git status is known. */
  readonly branch: ReturnType<typeof taskBranchProblem> | null | undefined;
  readonly workerRunning: boolean;
  readonly cloudLinked: boolean;
}): AgentdRunTasksOn | "local-or-cloud" | null {
  if (!input.suggestWorkers || input.dismissedInThread || !input.signal) return null;
  if (!input.codeThread || !input.agentdSetUp || input.workerRunning) return null;
  if (input.branch === undefined || input.branch === "not-repo") return null;
  if (input.branch === "detached") return input.cloudLinked ? "cloud" : null;
  if (input.branch === "protected" && input.cloudLinked) return "local-or-cloud";
  return "local";
}

/** The "Try a worker" card: once per environment, while agentd is healthy, in a Code thread in a git project. */
export function showFirstTaskCard(input: {
  readonly shownForEnvironment: boolean;
  readonly codeThread: boolean;
  readonly agentdOn: boolean;
  readonly isRepo: boolean | undefined;
}): boolean {
  return !input.shownForEnvironment && input.codeThread && input.agentdOn && input.isRepo === true;
}

/** The budget Hand to a worker fills when agentd has no estimate, from Settings → Workers. */
export function parseDefaultBudget(budget: string): { minutes: number; dollars: number } | null {
  const match = /^(\d{1,4})m,\$(\d{1,4}(?:\.\d{1,2})?)$/.exec(budget);
  if (!match) return null;
  return { minutes: Number(match[1]), dollars: Number(match[2]) };
}

/**
 * Whether to offer linking the LibraOS account: only when this agentd has Cloud Workers and no
 * account key yet. Null until agentd answers, so a linked account never sees the step.
 */
export function offerAccountLink(
  account: Pick<AgentdCloudSetup, "supported" | "problem"> | null | undefined,
): boolean | null {
  if (account === null || account === undefined) return null;
  return account.supported && account.problem === "setup";
}
