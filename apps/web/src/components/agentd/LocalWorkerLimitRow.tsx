import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";

import { agentdEnvironment, useAgentdCommands } from "~/lib/agentdState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "../settings/settingsLayout";
import { parseMaxWorkers, suggestedMaxWorkers } from "./agentdVisibility.logic";

/** Settings → Workers: agentd's `dispatch.max_workers`, with a suggestion from the CPU count. */
export function LocalWorkerLimitRow({
  environmentId,
  maxWorkers,
  cpuCount,
}: {
  readonly environmentId: EnvironmentId;
  readonly maxWorkers: number;
  readonly cpuCount: number | null;
}) {
  const gt = useGT();
  const id = useId();
  const canSet = useAtomValue(agentdEnvironment.setMaxWorkers.permissionAtom(environmentId));
  const { setMaxWorkers } = useAgentdCommands();
  const [text, setText] = useState(String(maxWorkers));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const typed = parseMaxWorkers(text);
  const suggested = cpuCount === null ? null : suggestedMaxWorkers(cpuCount);

  async function save(next: number) {
    setText(String(next));
    if (next === maxWorkers) return;
    setSaving(true);
    setFailure(null);
    const result = await setMaxWorkers({ environmentId, input: { maxWorkers: next } });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(
        error instanceof Error ? error.message : gt("LibraOS Engine did not change the setting."),
      );
      setText(String(maxWorkers));
    }
  }

  return (
    <SettingsRow
      id="workers-max-local"
      title={gt("Local workers at once")}
      description={
        <span className="flex flex-col gap-1">
          {typed === null ? (
            <span id={`${id}-hint`}>{gt("Enter a whole number from 1 to 64.")}</span>
          ) : (
            <T>How many workers may run on this machine at the same time.</T>
          )}
          {suggested !== null && cpuCount !== null && suggested !== maxWorkers ? (
            <span className="flex flex-wrap items-center gap-2">
              {gt("Suggested for this machine’s {cpuCount} CPU cores: {suggested}.", {
                cpuCount,
                suggested,
              })}
              <Button
                size="xs"
                variant="outline"
                disabled={!canSet || saving}
                onClick={() => void save(suggested)}
              >
                {gt("Use {suggested}", { suggested })}
              </Button>
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
        <Input
          aria-label={gt("Local workers at once")}
          aria-invalid={typed === null}
          aria-describedby={typed === null ? `${id}-hint` : undefined}
          inputMode="numeric"
          className="w-20"
          disabled={!canSet || saving}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (typed !== null) void save(typed);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed !== null) void save(typed);
          }}
        />
      }
    />
  );
}
