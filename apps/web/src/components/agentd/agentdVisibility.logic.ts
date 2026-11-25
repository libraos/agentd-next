import {
  AGENTD_MAX_WORKERS_LIMIT,
  type AgentdCloudSetup,
  type AgentdDoctorCheck,
  type AgentdRunTasksOn,
  type AgentdStatus,
  type AgentdTaskRow,
  type AgentdWorkerTool,
} from "@t3tools/contracts";
import { parseCompletionStatus } from "@t3tools/shared/orchestrationV2AutoContinuation";

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

/** The doctor check that says whether a worker tool can reach a model: its login, or opencode's gateway. */
const WORKER_SIGN_IN_CHECK = {
  claude: "claude-login",
  codex: "codex-login",
  opencode: "opencode-worker",
} as const satisfies Record<AgentdWorkerTool, string>;

const SIGN_IN_CHECKS = new Set<string>(Object.values(WORKER_SIGN_IN_CHECK));

/** What a background worker needs before it starts, in the order they are checked. */
export type WorkerPrerequisite = "engine" | "sign-in" | "repository";

/**
 * "Background workers" readiness: the engine set up and healthy, the worker signed in, and the
 * project a git repository. Missing agentd Skills only warn. `check` is agentd's own, with its fix.
 */
export type WorkerReadiness =
  | { readonly kind: "unknown" }
  | { readonly kind: "ready"; readonly missingSkills: ReadonlyArray<string> }
  | {
      readonly kind: "setup-required";
      readonly missing: WorkerPrerequisite;
      readonly engine?: "not-installed" | "not-set-up";
      readonly worker?: AgentdWorkerTool | null;
      readonly check?: AgentdDoctorCheck;
    }
  | {
      readonly kind: "setup-failed";
      readonly missing: "engine";
      readonly check?: AgentdDoctorCheck;
    };

export function workerReadiness(input: {
  readonly engine: AgentdIndicatorState;
  readonly status: Pick<AgentdStatus, "checks" | "defaultWorker" | "missingSkills"> | null;
  /** The worker a task would run; the default worker when the person chose none. */
  readonly worker?: AgentdWorkerTool | null;
  /** Cloud Workers bring their own model access, so this machine's sign-in does not apply. */
  readonly cloud?: boolean;
  /** Undefined with no project open; null while its git status is unknown. */
  readonly isRepo: boolean | null | undefined;
}): WorkerReadiness {
  const { engine, status } = input;
  if (engine === "unknown") return { kind: "unknown" };
  if (engine === "not-installed" || engine === "not-set-up")
    return { kind: "setup-required", missing: "engine", engine };
  if (status === null) return { kind: "setup-failed", missing: "engine" };
  // A worker's login is its own prerequisite: only the one that would run matters.
  const failing = status.checks.find(
    (check) => check.status === "fail" && !SIGN_IN_CHECKS.has(check.id),
  );
  if (failing) return { kind: "setup-failed", missing: "engine", check: failing };
  const worker = input.worker ?? status.defaultWorker ?? null;
  if (!input.cloud) {
    if (worker === null) return { kind: "setup-required", missing: "sign-in", worker };
    // An agentd without the check cannot say; it refuses the worker itself if it cannot sign in.
    const signIn = status.checks.find((check) => check.id === WORKER_SIGN_IN_CHECK[worker]);
    if (signIn !== undefined && signIn.status !== "pass")
      return { kind: "setup-required", missing: "sign-in", worker, check: signIn };
  }
  if (input.isRepo === false) return { kind: "setup-required", missing: "repository" };
  if (input.isRepo === null) return { kind: "unknown" };
  const skillsApply = !input.cloud && worker === (status.defaultWorker ?? null);
  return { kind: "ready", missingSkills: skillsApply ? (status.missingSkills ?? []) : [] };
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

/**
 * The "Try a worker" card: while agentd is healthy, in a Code thread in a git project, until the
 * person hides it for this run or chooses Never show again for the environment.
 */
export function showFirstTaskCard(input: {
  readonly neverShowAgain: boolean;
  readonly hiddenThisSession: boolean;
  readonly codeThread: boolean;
  readonly agentdOn: boolean;
  readonly isRepo: boolean | undefined;
}): boolean {
  if (input.neverShowAgain || input.hiddenThisSession) return false;
  return input.codeThread && input.agentdOn && input.isRepo === true;
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

/** A local worker limit for this many CPUs: one worker per four cores, at least one. */
export function suggestedMaxWorkers(cpuCount: number): number {
  return Math.min(AGENTD_MAX_WORKERS_LIMIT, Math.max(1, Math.floor(cpuCount / 4)));
}

/** A typed local worker limit, or null when it is not a whole number agentd takes. */
export function parseMaxWorkers(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const max = Number(trimmed);
  return max >= 1 && max <= AGENTD_MAX_WORKERS_LIMIT ? max : null;
}

/**
 * The offer under a finished turn whose status line says work is left: hand it to a worker here
 * or in Cloud Workers, or keep it in the chat. Only the thread's latest turn, once it is idle.
 */
export function remainingWorkOffer(input: {
  /** The turn's final assistant message as stored, status line included. */
  readonly finalMessage: string;
  readonly latestTurn: boolean;
  readonly turnRunning: boolean;
  readonly awaitingUser: boolean;
  readonly suggestWorkers: boolean;
  readonly agentdSetUp: boolean;
  readonly canStartTask: boolean;
  readonly hasWorkingDirectory: boolean;
  readonly dismissed: boolean;
  readonly cloudLinked: boolean;
}): { readonly remaining: string; readonly cloud: boolean } | null {
  if (!input.latestTurn || input.turnRunning || input.awaitingUser || input.dismissed) return null;
  if (!input.suggestWorkers || !input.agentdSetUp || !input.canStartTask) return null;
  if (!input.hasWorkingDirectory) return null;
  const status = parseCompletionStatus(input.finalMessage);
  if (status?.type !== "remaining") return null;
  return { remaining: status.detail, cloud: input.cloudLinked };
}
