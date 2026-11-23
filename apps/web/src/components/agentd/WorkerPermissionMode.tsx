import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdPermissionMode, AgentdTask, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { agentdEnvironment, useAgentdCommands, useAgentdPermissionMode } from "~/lib/agentdState";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { SettingsRow } from "../settings/settingsLayout";

// agentd takes raising only from a person at their own terminal; the app shows this, never runs it.
export const RAISE_PERMISSION_COMMAND = "agentd config set dispatch.permission_mode yolo";

function ModeText({ mode }: { readonly mode: AgentdPermissionMode }) {
  return mode === "guarded" ? (
    <>
      <span className="font-medium">
        <T>Ask first</T>
      </span>
      <span className="text-muted-foreground">
        <T>Workers stop and wait when a command needs permission. You answer in a terminal.</T>
      </span>
    </>
  ) : (
    <>
      <span className="font-medium">
        <T>Run without asking</T>
      </span>
      <span className="text-muted-foreground">
        <T>
          Workers run any command in their own worktree, with network. They still cannot push, merge
          or open a pull request, and budgets and checks still apply.
        </T>
      </span>
    </>
  );
}

/** Set-up's question: neither choice is selected until the person picks one. */
export function PermissionModeChoice({
  value,
  onChange,
  disabled,
}: {
  readonly value: AgentdPermissionMode | null;
  readonly onChange: (mode: AgentdPermissionMode) => void;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium text-sm">
        <T>How much may background workers do without asking?</T>
      </legend>
      <RadioGroup
        aria-label={gt("How much may background workers do without asking?")}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === "guarded" || next === "yolo") onChange(next);
        }}
      >
        {(["guarded", "yolo"] as const).map((mode) => (
          <label key={mode} className="flex items-start gap-2 text-sm">
            <Radio value={mode} className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <ModeText mode={mode} />
            </span>
          </label>
        ))}
      </RadioGroup>
      <p className="text-muted-foreground text-xs">
        <T>You can change this later in Settings → Workers.</T>
      </p>
    </fieldset>
  );
}

/** Settings → Workers: the mode read from agentd; Ask first at any time, raising at a terminal. */
export function WorkerPermissionModeRow({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useAgentdPermissionMode(environmentId);
  const canLower = useAtomValue(
    agentdEnvironment.lowerPermissionMode.permissionAtom(environmentId),
  );
  const { lowerPermissionMode } = useAgentdCommands();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showRaise, setShowRaise] = useState(false);
  const current = setting.data;
  if (current === null || current.mode === null) return null;

  async function askFirst() {
    setSaving(true);
    setFailure(null);
    setShowRaise(false);
    const result = await lowerPermissionMode({ environmentId, input: {} });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("AgentD did not change the setting."));
    }
    setting.refresh();
  }

  return (
    <SettingsRow
      id="workers-permission-mode"
      title={gt("Background workers")}
      description={
        <span className="flex flex-col gap-1 text-sm">
          <ModeText mode={current.mode} />
          {current.scopedYolo ? (
            <span className="text-muted-foreground">
              <T>
                Some roles or repositories run their workers without asking; change those at a
                terminal with agentd config set.
              </T>
            </span>
          ) : null}
          {showRaise ? (
            <span role="status" className="flex flex-col gap-1">
              <T>AgentD lets workers run without asking only when you set it in a terminal. Run:</T>
              <code className="w-fit select-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {RAISE_PERMISSION_COMMAND}
              </code>
            </span>
          ) : null}
          {failure !== null ? (
            <span role="alert" className="break-words text-destructive">
              {failure}
            </span>
          ) : null}
        </span>
      }
      control={
        current.mode === "yolo" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={saving || !canLower}
            onClick={() => void askFirst()}
          >
            <T>Ask first</T>
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={() => setShowRaise(true)}>
            <T>Run without asking</T>
          </Button>
        )
      }
    />
  );
}

/**
 * A worker stopped at its own tool's prompt (a permission prompt, a question): the app cannot
 * answer it, so it says what it waits for and how to open the worker's session.
 */
export function TaskWaiting({
  task,
}: {
  readonly task: Pick<AgentdTask, "waitingFor" | "attachCommand">;
}) {
  return (
    <div role="status" className="space-y-1 text-sm">
      <p className="font-medium">
        {task.waitingFor ? (
          <T>
            The worker is waiting: <Var>{task.waitingFor}</Var>
          </T>
        ) : (
          <T>The worker is waiting for an answer, such as a permission prompt.</T>
        )}
      </p>
      {task.attachCommand ? (
        <>
          <p className="text-muted-foreground">
            <T>Answer it in a terminal:</T>
          </p>
          <code className="block w-fit select-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {task.attachCommand}
          </code>
        </>
      ) : (
        <p className="text-muted-foreground">
          <T>Answer it in the worker&apos;s own session, or in AgentD&apos;s Inbox.</T>
        </p>
      )}
    </div>
  );
}
