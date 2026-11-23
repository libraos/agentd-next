import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentdBlockingTask,
  AgentdStartTaskResult,
  AgentdWorkerTool,
  EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { agentdEnvironment } from "~/lib/agentdState";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

/**
 * A Start agentd refused because another open task holds the folder: which task, and the person's
 * choice to release it (only when no worker of it runs) or to start anyway.
 */
export function BlockedTaskStart({
  environmentId,
  taskId,
  worker,
  blocking,
  onResult,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly worker: AgentdWorkerTool;
  readonly blocking: AgentdBlockingTask;
  /** Started, or refused again (perhaps by another task). */
  readonly onResult: (result: AgentdStartTaskResult) => void;
}) {
  const gt = useGT();
  const canStart = useAtomValue(agentdEnvironment.retryStart.permissionAtom(environmentId));
  const retryStart = useAtomCommand(agentdEnvironment.retryStart, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(action: "release" | "force") {
    setBusy(true);
    setError(null);
    const result = await retryStart({
      environmentId,
      input: { id: taskId, worker, action, blocking: blocking.id },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("AgentD could not start the task."));
      return;
    }
    onResult(result.value);
  }

  return (
    <div className="space-y-2">
      <p>
        {blocking.goal
          ? gt("Another task, “{goal}” ({taskId}), already holds this folder.", {
              goal: blocking.goal,
              taskId: blocking.id,
            })
          : gt("Another task, {taskId}, already holds this folder.", { taskId: blocking.id })}{" "}
        {blocking.running
          ? gt(
              "Its worker is still running, so it can’t be released here. Start anyway runs both tasks in this folder.",
            )
          : gt("It has no worker running. Release it to cancel it, or start anyway to run both.")}
      </p>
      {error !== null ? <p className="wrap-anywhere whitespace-pre-wrap">{error}</p> : null}
      <div className="flex gap-2">
        {blocking.running ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !canStart}
            onClick={() => void retry("release")}
          >
            <T>Release it</T>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !canStart}
          onClick={() => void retry("force")}
        >
          <T>Start anyway</T>
        </Button>
      </div>
    </div>
  );
}
