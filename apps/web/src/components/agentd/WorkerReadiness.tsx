import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { useAgentdStatus } from "~/lib/agentdState";
import { Button } from "../ui/button";
import { agentdIndicatorState, type WorkerReadiness } from "./agentdVisibility.logic";
import { TASK_WORKERS } from "./startTask.logic";

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

/** What a readiness says: its label, the reason, and the fix as a sentence or agentd's command. */
export function useWorkerReadinessText(readiness: WorkerReadiness) {
  const gt = useGT();
  const none = { reason: null, fix: null, command: null };
  switch (readiness.kind) {
    case "unknown":
      return { label: gt("Background workers"), ...none };
    case "ready":
      return {
        label: gt("Background workers: Ready"),
        ...none,
        ...(readiness.missingSkills.length === 0
          ? {}
          : {
              reason: gt(
                "LibraOS Engine Skills are missing: {skills}. Workers still start without them.",
                { skills: readiness.missingSkills.join(", ") },
              ),
            }),
      };
    case "setup-failed":
      return {
        label: gt("Background workers: Setup failed"),
        reason: readiness.check
          ? gt("LibraOS Engine check {check} is failing: {detail}", {
              check: readiness.check.id,
              detail: readiness.check.detail ?? readiness.check.status,
            })
          : gt("LibraOS Engine did not answer."),
        fix: readiness.check?.fix
          ? null
          : gt("Open the LibraOS Engine page to see its checks and Repair."),
        command: readiness.check?.fix ?? null,
      };
    case "setup-required": {
      const label = gt("Background workers: Setup required");
      switch (readiness.missing) {
        case "engine":
          return readiness.engine === "not-installed"
            ? {
                label,
                reason: gt("LibraOS Engine is not installed."),
                fix: gt("Open the LibraOS Engine page for how to install it."),
                command: null,
              }
            : {
                label,
                reason: gt("LibraOS Engine is not set up."),
                fix: gt("Choose Set up LibraOS Engine, or run this on the environment:"),
                command: "libraos-core init",
              };
        case "sign-in": {
          const worker = readiness.worker ? TASK_WORKERS[readiness.worker] : null;
          if (worker === null)
            return {
              label,
              reason: gt("LibraOS Engine names no default worker."),
              fix: gt("Choose one in a terminal on the environment:"),
              command: "libraos-core config set dispatch.default_tool claude",
            };
          return {
            label,
            reason: readiness.check?.detail
              ? gt("{worker} is not signed in: {detail}", {
                  worker,
                  detail: readiness.check.detail,
                })
              : gt("{worker} is not signed in.", { worker }),
            fix: readiness.check?.fix ? gt("Sign in on the environment:") : null,
            command: readiness.check?.fix ?? null,
          };
        }
        case "repository":
          return {
            label,
            reason: gt("This project is not a Git repository."),
            fix: gt(
              "Workers commit their work on a branch. Run this in the project folder, then make a first commit:",
            ),
            command: "git init",
          };
      }
    }
  }
}

/** The readiness's reason, its fix, and the one action that fixes it here, if there is one. */
export function WorkerReadinessNotice({
  environmentId,
  readiness,
  enginePage = true,
  onSetUp,
}: {
  readonly environmentId: EnvironmentId;
  readonly readiness: WorkerReadiness;
  /** Off where the LibraOS Engine page is linked already. */
  readonly enginePage?: boolean;
  /** Opens Set up LibraOS Engine; absent where this connection cannot, or the page offers it. */
  readonly onSetUp?: (() => void) | undefined;
}) {
  const text = useWorkerReadinessText(readiness);
  if (text.reason === null) return null;
  const engine =
    enginePage &&
    ((readiness.kind === "setup-required" && readiness.missing === "engine") ||
      readiness.kind === "setup-failed");
  const setUp = readiness.kind === "setup-required" && readiness.engine === "not-set-up" && onSetUp;
  const skills = readiness.kind === "ready";
  return (
    <div
      role={skills ? "status" : "alert"}
      className={
        skills
          ? "min-w-0 space-y-1 text-warning-foreground text-xs"
          : "min-w-0 space-y-1 text-destructive-foreground text-xs"
      }
    >
      <p className="wrap-anywhere">{text.reason}</p>
      {text.fix !== null ? <p className="wrap-anywhere text-muted-foreground">{text.fix}</p> : null}
      {text.command !== null ? (
        <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-foreground">
          {text.command}
        </code>
      ) : null}
      {skills ? <SkillsFix environmentId={environmentId} /> : null}
      {setUp || engine ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {setUp ? (
            <Button size="xs" variant="outline" onClick={onSetUp}>
              <T>Set up LibraOS Engine</T>
            </Button>
          ) : null}
          {engine ? (
            <Button size="xs" variant="outline" render={<Link to="/agentd" />}>
              <T>LibraOS Engine page</T>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SkillsFix({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const worker = useAgentdStatus(environmentId).data?.defaultWorker ?? null;
  if (worker === null) return null;
  return (
    <>
      <p className="text-muted-foreground">
        <T>To add them, run this on the environment:</T>
      </p>
      <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-foreground">
        libraos-core connect {worker}
      </code>
    </>
  );
}
