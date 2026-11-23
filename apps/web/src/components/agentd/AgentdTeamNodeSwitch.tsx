import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdTeamNodeStatus, AgentdWorkerTool, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { agentdEnvironment, useAgentdTeamNode } from "../../lib/agentdState";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { TASK_WORKERS } from "./startTask.logic";

// The server repeats this at most once a minute too; agentd keeps each declaration 10 minutes.
const SIGNAL_EVERY_MS = 60_000;

function NodeState({
  node,
  openTask,
}: {
  node: AgentdTeamNodeStatus;
  openTask: (id: string) => void;
}) {
  if (node.state === "working") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="success">
          <T>Working</T>
        </Badge>
        {node.task ? (
          <button
            type="button"
            className="break-all underline outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => openTask(node.task!)}
          >
            {node.task}
          </button>
        ) : null}
      </span>
    );
  }
  if (node.state === "failed") {
    return (
      <span className="space-y-1">
        <Badge variant="error">
          <T>Failed</T>
        </Badge>
        {node.note ? <p className="break-words text-muted-foreground">{node.note}</p> : null}
      </span>
    );
  }
  return (
    <Badge variant="secondary">
      {node.state === "waiting" ? <T>Waiting for work</T> : <T>Off</T>}
    </Badge>
  );
}

/** Work for the team: this environment takes the team server's work while switched on. */
export function AgentdTeamNodeSwitch({
  environmentId,
  openTask,
}: {
  environmentId: EnvironmentId;
  openTask: (id: string) => void;
}) {
  const gt = useGT();
  const id = useId();
  const ticketRef = useRef<HTMLInputElement>(null);
  const node = useAgentdTeamNode(environmentId);
  const canSet = useAtomValue(agentdEnvironment.setTeamNode.permissionAtom(environmentId));
  const setTeamNode = useAtomCommand(agentdEnvironment.setTeamNode, {
    reportFailure: false,
    reportDefect: false,
  });
  const folders = [
    ...new Set(
      useProjects()
        .filter((project) => project.environmentId === environmentId && !project.archivedAt)
        .map((project) => project.workspaceRoot),
    ),
  ];
  const [draft, setDraft] = useState<{ tool: AgentdWorkerTool | null; repo: string | null }>({
    tool: null,
    repo: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = node.data;
  if (data === null) return null;

  const tool = draft.tool ?? (data.tool && data.tools.includes(data.tool) ? data.tool : null);
  const repo = draft.repo ?? data.repo;
  const ready = tool !== null && repo !== null;

  async function apply(on: boolean, next: { tool: AgentdWorkerTool | null; repo: string | null }) {
    if (next.tool === null || next.repo === null) return;
    const field = ticketRef.current;
    const ticket = field?.value.trim() ?? "";
    if (field) field.value = "";
    setBusy(true);
    setError(null);
    const result = await setTeamNode({
      environmentId,
      input: { on, tool: next.tool, repo: next.repo, ...(ticket ? { ticket } : {}) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      const message = cause instanceof Error && cause.message ? cause.message : null;
      setError(
        message
          ? ticket
            ? message.replaceAll(ticket, "[redacted]")
            : message
          : gt("LibraOS Core could not change team work."),
      );
      return;
    }
    setDraft({ tool: null, repo: null });
  }

  const choose = (next: { tool: AgentdWorkerTool | null; repo: string | null }) => {
    setDraft(next);
    // A new agent or folder while on restarts the worker with it.
    if (data.on) void apply(true, next);
  };

  return (
    <div className="w-full space-y-3 rounded-md bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor={`${id}-on`}>
          <T>Work for the team</T>
        </Label>
        <Switch
          id={`${id}-on`}
          checked={data.on}
          disabled={!canSet || busy || (!data.on && !ready)}
          onCheckedChange={(checked) => void apply(checked, { tool, repo })}
        />
      </div>
      <p className="text-muted-foreground">
        <T>
          While on, the team server can give this environment a task when you are not using the app.
          The agent works in a new branch of the folder and pushes it.
        </T>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-tool`}>
            <T>Agent</T>
          </Label>
          <Select
            value={tool}
            items={TASK_WORKERS}
            disabled={!canSet || busy || data.tools.length === 0}
            onValueChange={(value) => choose({ tool: value as AgentdWorkerTool, repo })}
          >
            <SelectTrigger id={`${id}-tool`}>
              <SelectValue
                placeholder={
                  data.tools.length === 0
                    ? gt("No agent installed")
                    : gt("Choose", { $context: "placeholder of a select" })
                }
              />
            </SelectTrigger>
            <SelectPopup>
              {data.tools.map((value) => (
                <SelectItem key={value} value={value}>
                  {TASK_WORKERS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-repo`}>
            <T>Project folder</T>
          </Label>
          <Select
            value={repo}
            disabled={!canSet || busy}
            onValueChange={(value) => choose({ tool, repo: value as string })}
          >
            <SelectTrigger id={`${id}-repo`}>
              <SelectValue placeholder={gt("Choose", { $context: "placeholder of a select" })} />
            </SelectTrigger>
            <SelectPopup>
              {(repo !== null && !folders.includes(repo) ? [repo, ...folders] : folders).map(
                (folder) => (
                  <SelectItem key={folder} value={folder}>
                    {folder}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {!data.on ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-ticket`}>
            <T>Worker ticket (only if LibraOS Core asks for one)</T>
          </Label>
          <Input
            ref={ticketRef}
            id={`${id}-ticket`}
            type="password"
            autoComplete="off"
            maxLength={256}
            placeholder="adt_…"
            disabled={!canSet || busy}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          <T>Team work</T>
        </span>
        <NodeState node={data} openTask={openTask} />
      </div>
      {error !== null ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
      {!canSet ? (
        <p className="text-muted-foreground">
          <T>This connection cannot change team work.</T>
        </p>
      ) : null}
    </div>
  );
}

/** While the person uses the app and team work is on, tell agentd they are busy. */
export function AgentdTeamNodeBusySignal() {
  const environmentId = usePrimaryEnvironmentId();
  const node = useAgentdTeamNode(environmentId);
  const signal = useAtomCommand(agentdEnvironment.teamNodeForeground, {
    reportFailure: false,
    reportDefect: false,
  });
  const lastRef = useRef<number | null>(null);
  const on = node.data?.on === true;
  const onInput = useEffectEvent(() => {
    if (environmentId === null) return;
    const now = Date.now();
    if (lastRef.current !== null && now - lastRef.current < SIGNAL_EVERY_MS) return;
    lastRef.current = now;
    void signal({ environmentId, input: {} });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for input on the window
  useEffect(() => {
    if (!on || environmentId === null) return;
    const listener = () => onInput();
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events) window.addEventListener(event, listener, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, listener);
    };
  }, [on, environmentId]);

  return null;
}
