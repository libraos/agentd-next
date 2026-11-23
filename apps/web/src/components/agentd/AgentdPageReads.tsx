import type { AgentdStatus, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useLocale, Var } from "gt-react";
import type { ReactNode } from "react";

import type { useAgentdApprovals, useAgentdInbox } from "../../lib/agentdState";
import type { EnvironmentQueryView } from "../../state/query";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentdInstallStatus } from "./AgentdInstallStatus";

export function AgentdReadError({ error }: { error: string }) {
  return (
    <Alert variant="error">
      <AlertTitle>
        <T>Couldn't read AgentD</T>
      </AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function AgentdLoading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      <T>Loading…</T>
    </p>
  );
}

export function AgentdSection({
  id,
  title,
  children,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-xl border border-border p-4 sm:p-5">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function AgentdTimestamp({ value }: { value: string | null }) {
  const locale = useLocale();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>{value}</span>;
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)}
    </time>
  );
}

export function AgentdStatusDetails({
  status,
  team,
  onSetUp,
  environmentId,
  onRepaired,
}: {
  status: AgentdStatus;
  /** Where the services' Repair runs; null shows their notice without it. */
  environmentId: EnvironmentId | null;
  onRepaired: () => void;
  /** Opens Set up AgentD; absent when this connection cannot set agentd up. */
  onSetUp?: (() => void) | undefined;
  /** Shown under the team server once this environment is joined to one. */
  team?: ReactNode;
}) {
  const checks = status.checks.filter((check) => check.status !== "pass");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={status.ok ? "success" : "error"}>
          {status.ok ? <T>Checks passed</T> : <T>Checks failed</T>}
        </Badge>
        <span className="break-all text-sm text-muted-foreground">{status.version}</span>
      </div>
      {!status.setUp ? (
        <Alert variant="warning">
          <AlertTitle>
            <T>AgentD is not set up</T>
          </AlertTitle>
          <AlertDescription>
            <p>
              <T>
                Run <code>agentd init</code> on this environment.
              </T>
            </p>
            {onSetUp ? (
              <Button className="mt-2" size="sm" variant="outline" onClick={onSetUp}>
                <T>Set up AgentD</T>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 text-sm">
        <span className="font-medium">
          <T>Team</T>
        </span>
        {status.teamServer === null ? (
          <>
            <span className="text-muted-foreground">
              <T>Not joined</T>
            </span>
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/welcome" search={{ screen: "team" }} />}
            >
              <T>Join a team</T>
            </Button>
          </>
        ) : status.teamServer ? (
          <>
            <span className="break-all text-muted-foreground">{status.teamServer}</span>
            {team}
          </>
        ) : (
          <span className="text-muted-foreground">
            <T>Team connection not reported</T>
          </span>
        )}
      </div>
      <AgentdInstallStatus status={status} environmentId={environmentId} onRepaired={onRepaired} />
      {checks.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {checks.map((check) => (
            <li key={check.id} className="space-y-1 py-3 text-sm last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{check.id}</span>
                <Badge
                  variant={
                    check.status === "fail"
                      ? "error"
                      : check.status === "warn"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {check.status}
                </Badge>
              </div>
              {check.detail ? (
                <p className="break-words text-muted-foreground">{check.detail}</p>
              ) : null}
              {check.fix ? (
                <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs">
                  {check.fix}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AgentdRequester({ name }: { name: string | null | undefined }) {
  return name ? (
    <T>
      From <Var>{name}</Var>
    </T>
  ) : (
    <T>Requester not reported</T>
  );
}

export function AgentdRead<TData>({
  query,
  children,
}: {
  query: EnvironmentQueryView<TData>;
  children: (data: TData) => ReactNode;
}) {
  return (
    <>
      {query.error === null ? null : <AgentdReadError error={query.error} />}
      {query.data !== null ? children(query.data) : query.error === null ? <AgentdLoading /> : null}
    </>
  );
}

export function AgentdNeedsYou({
  approvals,
  inbox,
}: {
  approvals: ReturnType<typeof useAgentdApprovals>;
  inbox: ReturnType<typeof useAgentdInbox>;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-2">
        <h3 className="font-medium">
          <T>Pending approvals</T>
        </h3>
        <AgentdRead query={approvals}>
          {(items) =>
            items.length === 0 ? (
              <p className="text-muted-foreground">
                <T>No pending approvals.</T>
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  <T>Answer in a terminal on this environment using one of the commands below.</T>
                </p>
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <li key={item.id} className="space-y-1 py-2">
                      <p className="whitespace-pre-wrap break-words">{item.text}</p>
                      <p className="break-words text-xs text-muted-foreground">
                        <AgentdRequester name={item.requester} />
                      </p>
                      {/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(item.id) ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          <code className="break-all">
                            agentd approval answer {item.id} --approve
                          </code>
                          <code className="break-all">
                            agentd approval answer {item.id} --reject
                          </code>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        </AgentdRead>
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="font-medium">
          <T>Inbox</T>
        </h3>
        <AgentdRead query={inbox}>
          {(items) => {
            const open = items.filter((item) => !item.resolved);
            return open.length === 0 ? (
              <p className="text-muted-foreground">
                <T>No open inbox items.</T>
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {open.map((item) => (
                  <li key={item.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{item.kind}</Badge>
                      <p className="whitespace-pre-wrap break-words">{item.title}</p>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      <AgentdRequester name={item.requester} />
                    </p>
                  </li>
                ))}
              </ul>
            );
          }}
        </AgentdRead>
      </div>
    </div>
  );
}
