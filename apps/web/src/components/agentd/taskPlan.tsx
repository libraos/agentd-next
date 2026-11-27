import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentdCommandError,
  type AgentdStartTaskResult,
  type AgentdTaskDefaults,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT, useLocale } from "gt-react";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import {
  agentdEnvironment,
  useAgentdGitIdentity,
  useAgentdStatus,
  useAgentdTaskDefaults,
} from "~/lib/agentdState";
import { useLibraosGatewayConnected } from "~/lib/libraosGatewayState";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { BuyLibraosCreditsButton } from "./LibraosCredits";
import { followCloudKeyFiles } from "./PendingCloudKeyFiles";
import type { useStartTaskCloud } from "./StartTaskCloud";
import {
  autoBudget,
  budgetDollarCap,
  budgetMinutes,
  localBudget,
  prepareTaskFields,
  TASK_WORKERS,
  taskBranchProblem,
  taskMissingInputs,
  taskStartProblem,
  type TaskFields,
} from "./startTask.logic";
import { workerReadiness } from "./agentdVisibility.logic";
import { useWorkerDefaults } from "./workerSettings";
import { useAgentdState, useWorkerReadinessText, WorkerReadinessNotice } from "./WorkerReadiness";

const isCommandError = Schema.is(AgentdCommandError);

/** The session's project directory, where a task from it runs; a draft thread uses its project's. */
export function useTaskDirectory(threadRef: ScopedThreadRef) {
  const thread = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    thread ? null : store.getDraftThreadByRef(threadRef),
  );
  const source = thread ?? draft;
  const project = useProject(
    source ? scopeProjectRef(source.environmentId, source.projectId) : null,
  );
  return { thread, cwd: source?.worktreePath ?? project?.workspaceRoot ?? null };
}

export function useTaskDefaults(
  cwd: string | null,
  environmentId: EnvironmentId,
  size: TaskFields["size"],
): AgentdTaskDefaults | null {
  return useAgentdTaskDefaults(cwd, environmentId, size).data ?? null;
}

export type TaskStartOutcome =
  | { readonly kind: "started"; readonly task: AgentdStartTaskResult }
  | { readonly kind: "offered"; readonly task: AgentdStartTaskResult }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly outcomeUnknown: boolean;
      readonly replaceSubmission: string | null;
      /** A key file of the user's that agentd refused because others can read it. */
      readonly privateFile?: string;
    }
  | { readonly kind: "refused"; readonly reason: string }
  /** Claude Code never ran in folder: nothing started until the person trusts it. */
  | { readonly kind: "untrusted"; readonly folder: string };

/**
 * Everything a Start decides for the person: the fields filled from agentd's estimate and the
 * project, a one-line summary, the one problem that stops it, and the Start itself. The task card
 * in the chat and the Start task dialog share it, so both go through the same guarded path.
 */
export function useTaskPlan({
  threadRef,
  cwd,
  fields,
  checkEdited,
  defaults,
  cloud,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | null;
  readonly fields: TaskFields;
  /** The person changed the check, so a suggestion no longer fills an empty one. */
  readonly checkEdited: boolean;
  readonly defaults: AgentdTaskDefaults | null;
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { environmentId } = threadRef;
  const canStart = useAtomValue(agentdEnvironment.startTask.permissionAtom(environmentId));
  const status = useAgentdStatus(environmentId);
  const gatewayConnected = useLibraosGatewayConnected(environmentId);
  const git = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  // Cloud workers commit as their own account, so only a local Start reads this host's identity.
  const gitIdentity = useAgentdGitIdentity(
    cloud.enabled || cloud.waiting ? null : cwd,
    environmentId,
  );
  const gitIdentityMissing =
    gitIdentity.data !== null && (gitIdentity.data.name === "" || gitIdentity.data.email === "");
  const refreshBranch = useAtomCommand(vcsEnvironment.refreshLocalStatusForPicker, {
    reportFailure: false,
  });
  const startTask = useAtomCommand(agentdEnvironment.startTask, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const workerDefaults = useWorkerDefaults();

  const estimate = defaults?.estimate ?? null;
  const dollarBudgets = status.data?.dollarBudgets ?? null;
  const maxWorkers = status.data?.maxWorkers ?? null;
  const local = autoBudget({
    estimate,
    defaultMinutes: null,
    balanceUsd: null,
    fallback: workerDefaults.budget,
  });
  const filled: TaskFields = {
    ...fields,
    budget: fields.budget.trim() || localBudget(local, dollarBudgets),
    check: checkEdited || fields.check.trim() !== "" ? fields.check : (defaults?.check ?? ""),
  };
  const validation = prepareTaskFields(filled, { dollarBudgets });
  const worker = filled.worker ?? status.data?.defaultWorker ?? null;
  const branch = git.data ? taskBranchProblem(git.data) : null;
  // Checked before anything starts: the engine, the worker's sign-in and the repository.
  const engine = useAgentdState(environmentId).state;
  const readiness = workerReadiness({
    engine,
    status: status.data,
    worker,
    cloud: cloud.enabled || cloud.waiting,
    isRepo: cwd === null ? undefined : (git.data?.isRepo ?? null),
  });
  const readinessText = useWorkerReadinessText(readiness);
  // With no worker named, the form's own "Choose a worker" says it; the person can pick one here.
  const readinessBlocks =
    readiness.kind === "setup-failed" ||
    (readiness.kind === "setup-required" &&
      !(readiness.missing === "sign-in" && readiness.worker === null));
  const readinessProblem = readinessBlocks ? readinessText.reason : null;

  const money = (amount: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);
  const branchReason = (problem: ReturnType<typeof taskBranchProblem>) => {
    switch (problem) {
      case "not-repo":
        return gt("The working directory is not a Git repository.");
      case "detached":
        return gt("Check out a named branch in this working directory first.");
      case "protected":
      case null:
        return null;
    }
  };
  const noPricesReason = gt(
    "LibraOS Engine on this machine has no model prices, so it cannot hold a dollar limit. Use minutes, such as 60m.",
  );
  const problemKind = taskStartProblem({
    cloud: cloud.enabled,
    balanceUsd: cloud.setup?.balanceUsd ?? null,
    creditProblem: cloud.setup?.problem === "credit",
    modelAccess: cloud.modelAccess,
    planProblem: cloud.planProblem,
    signedIn: cloud.signedIn,
    gatewayConnected,
    worker,
    hasDirectory: cwd !== null,
    branch,
    gitIdentityMissing,
  });
  const missingLabels = {
    goal: gt("goal", { $context: "an input a task still needs before it can start" }),
    check: gt("check command", { $context: "an input a task still needs before it can start" }),
    worker: gt("worker", { $context: "an input a task still needs before it can start" }),
    budget: gt("valid budget", { $context: "an input a task still needs before it can start" }),
    directory: gt("working directory", {
      $context: "an input a task still needs before it can start",
    }),
    repository: gt("Git repository", {
      $context: "an input a task still needs before it can start",
    }),
    "git-identity": gt("Git name and email", {
      $context: "an input a task still needs before it can start",
    }),
  } as const;
  const missingKeys = taskMissingInputs({
    cloud: cloud.enabled || cloud.waiting,
    goal: validation.goal,
    check: validation.check,
    budgetValid: cloud.enabled ? cloud.budgetValid : validation.budget === null,
    worker,
    hasDirectory: cwd !== null,
    problem: problemKind,
  });
  const missing =
    missingKeys.length === 0
      ? null
      : gt("Still needed: {items}", {
          items: new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(
            missingKeys.map((key) => missingLabels[key]),
          ),
        });
  const problem = (() => {
    // Cloud was asked for: local checks such as the branch gate say nothing about it.
    if (cloud.waiting && cloud.unreachable)
      return cloud.checkoutUnknown
        ? gt(
            "Couldn’t read this checkout’s origin for Cloud Workers. Retry, or choose Edit and turn off Run in the cloud to run this task here.",
          )
        : gt(
            "Couldn’t reach LibraOS Engine to check Cloud Workers. Retry, or choose Edit and turn off Run in the cloud to run this task here.",
          );
    if (readinessProblem !== null) return readinessProblem;
    switch (problemKind) {
      case "no-directory":
        return gt("This session has no project working directory.");
      case "balance":
        return gt("There is not enough LibraOS credit for Cloud Workers.");
      case "sign-in":
        return gt("Sign in to LibraOS or connect the LibraOS Gateway to use LibraOS models.");
      case "subscription":
        return cloud.plan === "codex"
          ? gt("Set up your ChatGPT plan, or choose another model access.")
          : gt("Set up your Claude plan, or choose another model access.");
      case "worker":
        return gt("Choose a worker. The default is set in LibraOS Engine.");
      case "not-repo":
      case "detached":
        return branchReason(problemKind);
      case "git-identity":
        return gt("Git has no name or email on this computer, so a worker can’t commit its work.");
      case null:
        break;
    }
    if (!cloud.enabled && validation.budget === "no-prices") return noPricesReason;
    if (cloud.enabled && cloud.setup?.problem === "setup")
      return gt("Cloud Workers aren’t set up. Check the cloud configuration and account key file.");
    if (cloud.enabled && cloud.setup?.problem === "repository")
      return gt(
        "The repository owner must install the Cloud Workers GitHub App on this repository.",
      );
    if (!cloud.enabled && cwd !== null && git.error) return git.error;
    return null;
  })();
  const checking = cloud.enabled
    ? cloud.checkingBalance
    : cloud.waiting ||
      readiness.kind === "unknown" ||
      (cwd !== null && (git.data === null || gitIdentity.isPending));

  // A local dollar limit is promised only when agentd can hold it.
  const localDollars = validation.budget === null ? budgetDollarCap(validation.input.budget) : null;
  const localMinutes = budgetMinutes(validation.input.budget);
  // Still asked for the cloud while its probe is unanswered: the cap is the cloud's, not the local one.
  const capText =
    cloud.enabled || cloud.waiting
      ? money(Number(cloud.dollars) || 0)
      : localDollars === null
        ? null
        : money(localDollars);
  const budgetPart =
    capText !== null
      ? gt("budget up to {cap}", { cap: capText })
      : localMinutes !== null
        ? gt("time limit {minutes} min", { minutes: localMinutes })
        : null;
  const models = cloud.enabled
    ? cloud.modelAccess === "libraos"
      ? gt("LibraOS models")
      : cloud.modelAccess === "subscription"
        ? cloud.plan === "codex"
          ? gt("your ChatGPT plan")
          : gt("your Claude plan")
        : gt("your API key")
    : gatewayConnected
      ? gt("LibraOS models")
      : null;
  const summary = [
    cloud.enabled || cloud.waiting
      ? gt("Cloud Workers")
      : worker === null
        ? null
        : TASK_WORKERS[worker],
    budgetPart,
    models,
    validation.input.check
      ? gt("check: {check}", { check: validation.input.check })
      : gt("no check"),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const estimateLine =
    capText === null
      ? dollarBudgets === false
        ? gt("No dollar limit: LibraOS Engine on this machine has no model prices.")
        : gt("No dollar limit: the budget names only minutes.")
      : estimate === null
        ? gt("Budget up to {cap} (LibraOS Engine has no estimate for similar tasks yet).", {
            cap: capText,
          })
        : gt("Budget up to {cap} (similar tasks cost {low}–{high}).", {
            cap: capText,
            low: money(estimate.low),
            high: money(estimate.high),
          }) +
          (cloud.enabled ? ` ${gt("The estimate comes from local runs of similar tasks.")}` : "");

  const defaultBranch = branch === "protected" ? (git.data?.refName ?? null) : null;
  const whereLine =
    cloud.enabled || cloud.waiting || defaultBranch === null
      ? null
      : gt("Runs on a new branch in its own worktree, from {branch}.", { branch: defaultBranch });

  const ready =
    canStart &&
    problem === null &&
    !checking &&
    validation.goal === null &&
    (validation.check === null || (cloud.enabled && validation.check === "required")) &&
    !validation.accept &&
    !cloud.waiting &&
    (cloud.enabled ? cloud.input !== null : validation.budget === null && !validation.issue);

  async function run(
    replacing: string | null,
    trustClaudeFolder: boolean,
  ): Promise<TaskStartOutcome> {
    if (cwd === null)
      return { kind: "refused", reason: gt("This session has no project working directory.") };
    if (readinessProblem !== null) return { kind: "refused", reason: readinessProblem };
    if (cloud.waiting)
      return {
        kind: "refused",
        reason: gt("Couldn’t reach LibraOS Engine to check Cloud Workers."),
      };
    if (!cloud.enabled) {
      const current = await refreshBranch({ environmentId, input: { cwd } });
      if (current._tag === "Failure") {
        return {
          kind: "failed",
          error: squashAtomCommandFailure(current),
          outcomeUnknown: false,
          replaceSubmission: null,
        };
      }
      const reason = branchReason(taskBranchProblem(current.value));
      if (reason !== null) return { kind: "refused", reason };
    }
    const { goal, accept, check } = validation.input;
    const input = cloud.enabled
      ? cloud.input && {
          goal,
          accept,
          check: check || null,
          cwd,
          cloud:
            replacing === null ? cloud.input : { ...cloud.input, replaceSubmission: replacing },
        }
      : worker !== null && {
          ...validation.input,
          cwd,
          worker,
          ...(trustClaudeFolder ? { trustClaudeFolder } : {}),
        };
    if (!input) return { kind: "refused", reason: gt("LibraOS Engine could not start the task.") };
    const result = await startTask({ environmentId, input });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      if (isCommandError(failure) && failure.untrustedFolder !== undefined)
        return { kind: "untrusted", folder: failure.untrustedFolder };
      if (isCommandError(failure) && failure.wrongKeyFile !== undefined)
        return {
          kind: "refused",
          reason:
            failure.wrongKeyFile === "openai"
              ? gt(
                  "The file in the OpenAI key field holds an Anthropic key, so nothing was submitted. Put each key file in its own provider’s field.",
                )
              : gt(
                  "The file in the Anthropic key field holds an OpenAI key, so nothing was submitted. Put each key file in its own provider’s field.",
                ),
        };
      return {
        kind: "failed",
        error: failure,
        outcomeUnknown: isCommandError(failure) && failure.outcomeUnknown === true,
        replaceSubmission: isCommandError(failure) ? (failure.replaceSubmission ?? null) : null,
        ...(isCommandError(failure) && failure.privateFile !== undefined
          ? { privateFile: failure.privateFile }
          : {}),
      };
    }
    // A recorded task the cloud refused keeps the last paths that worked.
    if (cloud.enabled && cloud.input !== null && result.value.started) cloud.remember(cloud.input);
    if (result.value.started) return { kind: "started", task: result.value };
    // An earlier submission's task carries none of this Start's paths.
    if (cloud.enabled && cloud.input !== null && result.value.earlier !== true)
      followCloudKeyFiles(environmentId, result.value.id, cloud.input);
    return { kind: "offered", task: result.value };
  }

  /** One Start at a time; null while one is running. trustClaudeFolder answers an untrusted one. */
  function start(
    replacing: string | null = null,
    trustClaudeFolder = false,
  ): Promise<TaskStartOutcome | null> {
    if (startingRef.current) return Promise.resolve(null);
    startingRef.current = true;
    setStarting(true);
    return run(cloud.enabled ? replacing : null, trustClaudeFolder)
      .catch((error: unknown): TaskStartOutcome => ({
        kind: "failed",
        error,
        outcomeUnknown: false,
        replaceSubmission: null,
      }))
      .finally(() => {
        startingRef.current = false;
        setStarting(false);
      });
  }

  return {
    environmentId,
    readiness,
    readinessBlocks,
    canStart,
    dollarBudgets,
    maxWorkers,
    noPricesReason,
    filled,
    validation,
    worker,
    branch,
    gatewayConnected,
    git,
    gitIdentity,
    gitIdentityMissing,
    problem,
    // Cloud Workers spend the same LibraOS balance the Gateway does.
    needsCredits: problemKind === "balance",
    missing,
    checking,
    summary,
    estimateLine,
    whereLine,
    ready,
    starting,
    startingRef,
    start,
  };
}

/** The one-line summary of a Start, the estimate behind its budget, and what stops it. */
export function TaskPlanSummary({
  plan,
}: {
  readonly plan: Pick<
    ReturnType<typeof useTaskPlan>,
    | "summary"
    | "estimateLine"
    | "whereLine"
    | "problem"
    | "needsCredits"
    | "environmentId"
    | "readiness"
    | "readinessBlocks"
  >;
}) {
  const blocked = plan.readinessBlocks;
  return (
    <div className="min-w-0 space-y-1">
      <p className="wrap-anywhere text-sm">{plan.summary}</p>
      <p className="text-muted-foreground text-xs">{plan.estimateLine}</p>
      {plan.whereLine !== null ? (
        <p className="wrap-anywhere text-muted-foreground text-xs">{plan.whereLine}</p>
      ) : null}
      {blocked || plan.readiness.kind === "ready" ? (
        <WorkerReadinessNotice environmentId={plan.environmentId} readiness={plan.readiness} />
      ) : null}
      {plan.problem !== null && !blocked ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {plan.problem}
        </p>
      ) : null}
      {plan.needsCredits && !blocked ? (
        <BuyLibraosCreditsButton environmentId={plan.environmentId} variant="outline" />
      ) : null}
    </div>
  );
}
