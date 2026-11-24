import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentdCommandError,
  type AgentdBlockingTask,
  type AgentdStartTaskResult,
  type AgentdWorkerTool,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { agentdEnvironment, useAgentdCommands } from "../../lib/agentdState";
import { formatEnvironmentQueryError } from "../../state/query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { BlockedTaskStart } from "./BlockedTaskStart";
import { ClaudeTrustDialog } from "./ClaudeTrustDialog";
import { TASK_WORKERS } from "./startTask.logic";

const isCommandError = Schema.is(AgentdCommandError);
const workers = Object.keys(TASK_WORKERS) as AgentdWorkerTool[];

export function StartQueuedTaskMenu({
  id,
  environmentId,
  cwd,
  force,
}: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly force: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const canStart = useAtomValue(agentdEnvironment.retryStart.permissionAtom(environmentId));
  const { retryStart } = useAgentdCommands();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    worker: AgentdWorkerTool;
    blocking: AgentdBlockingTask;
  } | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  if (!canStart) return null;

  const handleResult = (worker: AgentdWorkerTool, result: AgentdStartTaskResult) => {
    const blocking = force ? undefined : result.blocking;
    setConflict(blocking ? { worker, blocking } : null);
    setError(
      result.started || blocking
        ? null
        : (result.note ?? gt("LibraOS Core could not start the task.")),
    );
  };

  const start = async (worker: AgentdWorkerTool, trustedFolder?: string) => {
    setFolder(null);
    setPending(true);
    const result = await retryStart({
      environmentId,
      input: {
        id,
        action: force ? "parked" : "queued",
        worker,
        ...(trustedFolder ? { trustedFolder } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      if (isCommandError(failure) && failure.untrustedFolder !== undefined) {
        setFolder(failure.untrustedFolder);
      } else {
        const refusal = isCommandError(failure) ? failure.queuedStartRefusal : undefined;
        switch (refusal) {
          case "no-longer-queued":
            setError(gt("This task is no longer waiting for an agent."));
            break;
          case "has-recipient":
            setError(gt("This task was sent to a specific session."));
            break;
          case "no-checkout":
            setError(gt("No local checkout is available for this task."));
            break;
          default:
            setError(formatEnvironmentQueryError(result.cause, resolve));
        }
      }
      return;
    }
    handleResult(worker, result.value);
  };

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost" />} disabled={pending}>
          {force ? <T>Start anyway</T> : <T>Start with…</T>}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>
              <span className="block max-w-xs wrap-anywhere">
                <T>
                  Working directory: <Var>{cwd}</Var>
                </T>
              </span>
            </MenuGroupLabel>
            {workers.map((worker) => (
              <MenuItem key={worker} onClick={() => void start(worker)}>
                {TASK_WORKERS[worker]}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <ClaudeTrustDialog
        folder={folder}
        onTrust={() => void start("claude", folder ?? undefined)}
        onCancel={() => setFolder(null)}
      />
      <AlertDialog
        open={error !== null || conflict !== null}
        onOpenChange={(open) => {
          if (open) return;
          setError(null);
          setConflict(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Couldn&apos;t start task</T>
            </AlertDialogTitle>
            {error === null ? null : <AlertDialogDescription>{error}</AlertDialogDescription>}
            {conflict === null ? null : (
              <BlockedTaskStart
                environmentId={environmentId}
                taskId={id}
                worker={conflict.worker}
                blocking={conflict.blocking}
                queued
                onResult={(result) => handleResult(conflict.worker, result)}
              />
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Close</T>
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
