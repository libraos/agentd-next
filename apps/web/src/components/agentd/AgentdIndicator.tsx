import type { AgentdStatus, EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";

import { useAgentdCloudAccount, useAgentdStatus } from "~/lib/agentdState";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
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
  agentdIndicatorState,
  offerAccountLink,
  type AgentdIndicatorState,
} from "./agentdVisibility.logic";
import { TASK_WORKERS } from "./startTask.logic";

/** The open thread's environment, else the primary one. */
function useAgentdIndicatorEnvironment(): EnvironmentId | null {
  const params = useParams({ strict: false });
  const primary = usePrimaryEnvironmentId();
  const target = resolveThreadRouteTarget(params);
  return target?.kind === "server" ? target.threadRef.environmentId : primary;
}

export function useAgentdState(environmentId: EnvironmentId | null) {
  const status = useAgentdStatus(environmentId);
  const failureTag =
    status.failure !== null && typeof status.failure === "object" && "_tag" in status.failure
      ? String(status.failure._tag)
      : status.error !== null
        ? "unknown"
        : null;
  return { state: agentdIndicatorState(status.data, failureTag), status: status.data };
}

const DOT_CLASS: Record<AgentdIndicatorState, string> = {
  unknown: "bg-muted-foreground/50",
  "not-installed": "bg-muted-foreground",
  "not-set-up": "bg-warning",
  attention: "bg-destructive",
  on: "bg-success",
};

function useAgentdStateLabel(state: AgentdIndicatorState) {
  const gt = useGT();
  switch (state) {
    case "unknown":
      return gt("LibraOS Engine");
    case "not-installed":
      return gt("LibraOS Engine: not installed");
    case "not-set-up":
      return gt("LibraOS Engine: not set up");
    case "attention":
      return gt("LibraOS Engine: needs attention");
    case "on":
      return gt("LibraOS Engine: on");
  }
}

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

/** The sidebar row: agentd's state at a glance, with the fix one click away. */
export function AgentdIndicator() {
  const environmentId = useAgentdIndicatorEnvironment();
  const { state, status } = useAgentdState(environmentId);
  const canSetUp = useCanSetUpAgentd(environmentId);
  const navigate = useNavigate();
  const label = useAgentdStateLabel(state);
  if (environmentId === null) return null;

  const content = (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])} />
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{label}</span>
    </>
  );
  const rowClass =
    "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset";

  return state === "on" ? (
    <Popover>
      <PopoverTrigger render={<button type="button" aria-label={label} className={rowClass} />}>
        {content}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact" width="sm">
        <div className="space-y-3">
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
  ) : (
    <button
      type="button"
      aria-label={label}

      className={rowClass}
      onClick={() => {
        if (state === "not-set-up" && canSetUp) openAgentdSetupDialog(environmentId);
        else void navigate({ to: "/agentd" });
      }}
    >
      {content}
    </button>
  );
}
