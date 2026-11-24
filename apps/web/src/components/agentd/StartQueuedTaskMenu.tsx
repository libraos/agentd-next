import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AgentdCommandError, type AgentdWorkerTool, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { agentdEnvironment, useAgentdCommands } from "../../lib/agentdState";
import { formatEnvironmentQueryError } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ClaudeTrustDialog } from "./ClaudeTrustDialog";

const isCommandError = Schema.is(AgentdCommandError);

export function StartQueuedTaskMenu({
  id,
  environmentId,
}: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const canStart = useAtomValue(agentdEnvironment.retryStart.permissionAtom(environmentId));
  const { retryStart } = useAgentdCommands();
  const [status, setStatus] = useState<"idle" | "pending" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  if (!canStart) return null;

  const start = async (worker: AgentdWorkerTool, trustedFolder?: string) => {
    setFolder(null);
    setError(null);
    setStatus("pending");
    const result = await retryStart({
      environmentId,
      input: { id, action: "queued", worker, ...(trustedFolder ? { trustedFolder } : {}) },
    });
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
      setStatus("idle");
      return;
    }
    if (result.value.started) {
      setStatus("requested");
      return;
    }
    setError(result.value.note ?? gt("LibraOS Core could not start the task."));
    setStatus("idle");
  };

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost" />} disabled={status !== "idle"}>
          {status === "requested" ? <T>Start requested</T> : <T>Start with…</T>}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void start("claude")}>Claude Code</MenuItem>
          <MenuItem onClick={() => void start("codex")}>Codex</MenuItem>
          <MenuItem onClick={() => void start("opencode")}>opencode</MenuItem>
        </MenuPopup>
      </Menu>
      <ClaudeTrustDialog
        folder={folder}
        onTrust={() => void start("claude", folder ?? undefined)}
        onCancel={() => setFolder(null)}
      />
      {error ? (
        <p className="max-w-32 basis-full wrap-anywhere text-xs text-destructive" role="alert">
          <T>
            Couldn&apos;t start task: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
    </>
  );
}
