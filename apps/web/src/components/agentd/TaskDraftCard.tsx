import type { AgentdBlockingTask, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useLibraosGatewayConnected } from "~/lib/libraosGatewayState";
import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ClaudeTrustDialog } from "./ClaudeTrustDialog";
import { BlockedTaskStart } from "./BlockedTaskStart";
import { useStartTaskCloud } from "./StartTaskCloud";
import { OfferedCloudTask, openStartTaskDialog, replaceQuestion } from "./StartTaskDialog";
import type { TaskFields } from "./startTask.logic";
import {
  TaskPlanSummary,
  type TaskStartOutcome,
  useTaskDefaults,
  useTaskDirectory,
  useTaskPlan,
} from "./taskPlan";

/** A task the session's agent drafted, shown in the conversation to start with one look. */
export function TaskDraftCard({
  threadRef,
  fields,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly fields: TaskFields;
}) {
  const gt = useGT();
  const { cwd } = useTaskDirectory(threadRef);
  const defaults = useTaskDefaults(cwd, threadRef.environmentId, fields.size);
  const gatewayConnected = useLibraosGatewayConnected(threadRef.environmentId);
  const cloud = useStartTaskCloud(cwd, threadRef.environmentId, {
    estimate: defaults?.estimate ?? null,
    gatewayConnected,
  });
  const plan = useTaskPlan({ threadRef, cwd, fields, checkEdited: true, defaults, cloud });
  const [result, setResult] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  // A cloud task agentd saved but didn't confirm: followed until the synced list shows it started.
  const [offered, setOffered] = useState<string | null>(null);
  const [replaceSubmission, setReplaceSubmission] = useState<string | null>(null);
  const [untrustedFolder, setUntrustedFolder] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<AgentdBlockingTask | null>(null);

  function settle(outcome: TaskStartOutcome) {
    setBlocking(outcome.kind === "offered" ? (outcome.task.blocking ?? null) : null);
    switch (outcome.kind) {
      case "started":
        setResult(null);
        setStartedId(outcome.task.id);
        useRightPanelStore.getState().open(rightPanelHostRef(threadRef), "background-tasks");
        toastManager.add({
          type: "success",
          title: gt("Started task {taskId}.", { taskId: outcome.task.id }),
        });
        return;
      case "offered":
        setStartedId(outcome.task.id);
        // An earlier submission's task agentd found is not this draft's to follow.
        if (cloud.enabled && outcome.task.earlier !== true) setOffered(outcome.task.id);
        setResult(
          outcome.task.note ??
            gt("Task {taskId} was offered but did not start.", { taskId: outcome.task.id }),
        );
        return;
      case "refused":
        setResult(outcome.reason);
        return;
      case "untrusted":
        setUntrustedFolder(outcome.folder);
        return;
      case "failed":
        setReplaceSubmission(outcome.replaceSubmission);
        setResult(
          outcome.replaceSubmission !== null
            ? replaceQuestion(gt)
            : outcome.error instanceof Error
              ? outcome.error.message
              : gt("AgentD could not start the task."),
        );
    }
  }

  async function start(replacing: string | null = null, trustClaudeFolder = false) {
    setResult(null);
    setReplaceSubmission(null);
    setUntrustedFolder(null);
    const outcome = await plan.start(replacing, trustClaudeFolder);
    if (outcome !== null) settle(outcome);
  }

  return (
    <section
      aria-label={gt("Drafted task")}
      className="my-1 min-w-0 space-y-2 rounded-lg border border-border p-3"
    >
      <p className="wrap-anywhere text-sm font-medium">{plan.filled.goal}</p>
      <TaskPlanSummary plan={plan} />
      <ClaudeTrustDialog
        folder={untrustedFolder}
        onTrust={() => void start(null, true)}
        onCancel={() => setUntrustedFolder(null)}
      />
      {startedId !== null && blocking !== null && plan.worker !== null ? (
        <div role="status" className="text-xs">
          <BlockedTaskStart
            key={blocking.id}
            environmentId={threadRef.environmentId}
            taskId={startedId}
            worker={plan.worker}
            blocking={blocking}
            onResult={(task) => settle({ kind: task.started ? "started" : "offered", task })}
          />
        </div>
      ) : result !== null ? (
        <OfferedCloudTask environmentId={threadRef.environmentId} taskId={offered}>
          <p role="status" className="wrap-anywhere whitespace-pre-wrap text-xs">
            {result}
          </p>
        </OfferedCloudTask>
      ) : null}
      {startedId === null && cloud.enabled && replaceSubmission !== null ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!plan.ready || plan.starting}
            onClick={() => void start(replaceSubmission)}
          >
            {plan.starting ? <T>Starting…</T> : <T>Replace</T>}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={plan.starting}
            onClick={() => {
              setResult(null);
              setReplaceSubmission(null);
            }}
          >
            <T>Don’t replace</T>
          </Button>
        </div>
      ) : startedId === null ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!plan.ready || plan.starting}
            onClick={() => void start()}
          >
            {plan.starting ? <T>Starting…</T> : <T>Start</T>}
          </Button>
          {cloud.waiting && cloud.unreachable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={plan.starting}
              onClick={cloud.refresh}
            >
              <T>Retry</T>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={plan.starting}
            onClick={() => openStartTaskDialog(threadRef, plan.filled)}
          >
            <T>Edit</T>
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {gt("Task {taskId} is in Background tasks.", { taskId: startedId })}
        </p>
      )}
    </section>
  );
}
