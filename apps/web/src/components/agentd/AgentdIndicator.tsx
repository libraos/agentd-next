import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AgentdStatus, EnvironmentId } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useAgentdCloudAccount } from "~/lib/agentdState";
import { cn } from "~/lib/utils";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  openAgentdLinkDialog,
  openAgentdSetupDialog,
  useCanSetUpAgentd,
} from "./AgentdSetupDialog";
import {
  offerAccountLink,
  workerReadiness,
  type AgentdIndicatorState,
  type WorkerReadiness,
} from "./agentdVisibility.logic";
import { TASK_WORKERS } from "./startTask.logic";
import { useAgentdState, useWorkerReadinessText, WorkerReadinessNotice } from "./WorkerReadiness";

/** The open thread's environment and project folder; else the primary environment and none. */
function useAgentdIndicatorTarget() {
  const params = useParams({ strict: false });
  const primary = usePrimaryEnvironmentId();
  const target = resolveThreadRouteTarget(params);
  const thread = useQuietThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const source = thread ?? draft;
  const project = useProject(
    source ? scopeProjectRef(source.environmentId, source.projectId) : null,
  );
  return {
    environmentId:
      source?.environmentId ??
      (target?.kind === "server" ? target.threadRef.environmentId : primary),
    cwd: source?.worktreePath ?? project?.workspaceRoot ?? null,
  };
}

/** Whether background workers can start from the open project, judged as Hand to a worker would. */
function useIndicatorReadiness(environmentId: EnvironmentId | null, cwd: string | null) {
  const { state, status } = useAgentdState(environmentId);
  const git = useEnvironmentQuery(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const isRepo = cwd === null ? undefined : (git.data?.isRepo ?? null);
  return { state, status, readiness: workerReadiness({ engine: state, status, isRepo }) };
}

const DOT_CLASS: Record<WorkerReadiness["kind"], string> = {
  unknown: "bg-muted-foreground/50",
  "setup-required": "bg-warning",
  "setup-failed": "bg-destructive",
  ready: "bg-success",
};

/** The two things agentd keeps apart: setup on this machine, and the optional LibraOS account. */
export function AgentdStatusLines({
  environmentId,
  state,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: AgentdIndicatorState;
  readonly status: AgentdStatus | null;
}) {
  const gt = useGT();
  const locale = useLocale();
  const account = useAgentdCloudAccount(state === "on" ? environmentId : null).data;
  const failing = status?.checks.find((check) => check.status === "fail");
  const worker = status?.defaultWorker ? TASK_WORKERS[status.defaultWorker] : null;
  const machine =
    state === "not-installed"
      ? gt("LibraOS Engine is not installed")
      : state === "not-set-up"
        ? gt("not set up")
        : state === "attention"
          ? failing
            ? gt("check failing: {check}", { check: failing.detail ?? failing.id })
            : gt("LibraOS Engine did not answer")
          : state === "on"
            ? worker
              ? gt("set up, default worker {worker}", { worker })
              : gt("set up")
            : gt("checking…");
  const linked = account?.supported === true && account.problem !== "setup";
  const credit =
    account?.balanceUsd == null
      ? null
      : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          account.balanceUsd,
        );
  const libraos =
    account === null || account === undefined
      ? state === "on"
        ? gt("checking…")
        : gt("not linked (optional): Cloud Workers and reporting need it")
      : linked
        ? credit
          ? gt("linked, Cloud Workers credit {credit}", { credit })
          : gt("linked")
        : gt("not linked (optional): Cloud Workers and reporting need it");
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="font-medium">
        <T>This machine</T>
      </dt>
      <dd className="wrap-anywhere text-muted-foreground">{machine}</dd>
      <dt className="font-medium">
        <T>LibraOS account</T>
      </dt>
      <dd className="wrap-anywhere flex flex-wrap items-center gap-x-1 text-muted-foreground">
        <span>{libraos}</span>
        {offerAccountLink(account) === true ? (
          <Button size="xs" variant="link" onClick={() => openAgentdLinkDialog(environmentId)}>
            <T>Link account</T>
          </Button>
        ) : null}
      </dd>
    </dl>
  );
}

/** Whether the LibraOS account is linked for Cloud Workers; null while unknown or not asked. */
export function useCloudWorkersLinked(environmentId: EnvironmentId | null): boolean | null {
  const account = useAgentdCloudAccount(environmentId).data;
  if (environmentId === null || account === null || account === undefined) return null;
  return account.supported && account.problem !== "setup";
}

/** The sidebar row: whether background workers can start, with the reason and fix one click away. */
export function AgentdIndicator() {
  const { environmentId, cwd } = useAgentdIndicatorTarget();
  const { state, status, readiness } = useIndicatorReadiness(environmentId, cwd);
  const { label, reason } = useWorkerReadinessText(readiness);
  const canSetUp = useCanSetUpAgentd(environmentId);
  if (environmentId === null) return null;

  const rowClass =
    "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset";

  return (
    <Popover>
      <PopoverTrigger render={<button type="button" aria-label={label} className={rowClass} />}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[readiness.kind])}
              />
            }
          />
          <TooltipPopup side="top">{reason === null ? label : `${label}. ${reason}`}</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
          {label}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact" width="sm">
        <div className="space-y-3">
          <p className="font-medium text-sm">{label}</p>
          <WorkerReadinessNotice
            environmentId={environmentId}
            readiness={readiness}
            enginePage={false}
            onSetUp={canSetUp ? () => openAgentdSetupDialog(environmentId) : undefined}
          />
          <AgentdStatusLines environmentId={environmentId} state={state} status={status} />
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" render={<Link to="/agentd" />}>
              <T>LibraOS Engine page</T>
            </Button>
            <Button size="xs" variant="outline" render={<Link to="/settings/workers" />}>
              <T>Worker settings</T>
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
