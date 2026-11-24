import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { CustomGatewayAgent, CustomGatewaySummary, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useId, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useCustomGatewayCommands, useCustomGateways } from "../../lib/customGatewayState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** The environment's custom gateways, each with its models, Rename and Remove. Nothing while there are none. */
const AGENT_LABELS: Record<CustomGatewayAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  pi: "Pi",
};

export function CustomGatewayList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { data } = useCustomGateways(environmentId);
  const gateways = data?.gateways ?? [];
  if (gateways.length === 0) return null;
  return (
    <section aria-label={gt("Your gateways")} className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">
        <T>Your gateways</T>
      </h2>
      <ul className="space-y-2">
        {gateways.map((gateway) => (
          <GatewayRow key={gateway.id} environmentId={environmentId} gateway={gateway} />
        ))}
      </ul>
    </section>
  );
}

function GatewayRow({
  environmentId,
  gateway,
}: {
  readonly environmentId: EnvironmentId;
  readonly gateway: CustomGatewaySummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const { canChange, rename, remove, setHiddenModels } = useCustomGatewayCommands(environmentId);
  const [choosingModels, setChoosingModels] = useState(false);
  // The choice being saved, so a box answers the click before the server does.
  const [savingHidden, setSavingHidden] = useState<ReadonlyArray<string> | null>(null);
  const hiddenModels = savingHidden ?? gateway.hiddenModels;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(gateway.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || !canChange;

  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) =>
    thrownErrorMessage(squashAtomCommandFailure(result), m) ||
    gt("Could not reach this environment.");

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await rename({ environmentId, input: { id: gateway.id, name } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failure(result));
      return;
    }
    setRenaming(false);
  };

  const confirmRemove = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Remove {name}? Its agents and key are removed from this environment.", {
        name: gateway.name,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    const result = await remove({ environmentId, input: { id: gateway.id } });
    setBusy(false);
    if (result._tag === "Failure") setError(failure(result));
  };

  const setModelHidden = async (model: string, hidden: boolean) => {
    const next = hidden
      ? [...gateway.hiddenModels, model]
      : gateway.hiddenModels.filter((entry) => entry !== model);
    setBusy(true);
    setError(null);
    setSavingHidden(next);
    const result = await setHiddenModels({
      environmentId,
      input: { id: gateway.id, hiddenModels: next },
    });
    setSavingHidden(null);
    setBusy(false);
    if (result._tag === "Failure") setError(failure(result));
  };
  const allModels = [...gateway.models, ...gateway.hiddenModels].toSorted((a, b) =>
    a.localeCompare(b),
  );

  const format =
    gateway.format === "both" ? gt("Both") : gateway.format === "openai" ? "OpenAI" : "Anthropic";
  const agents = gateway.agents.map((agent) => AGENT_LABELS[agent]).join(", ");

  return (
    <li className="space-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      {renaming ? (
        <form onSubmit={submitRename} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-name`} className="sr-only">
            <T>Name</T>
          </label>
          <Input
            id={`${id}-name`}
            className="min-w-0 flex-1"
            autoComplete="off"
            autoFocus
            placeholder={gateway.url}
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" disabled={disabled}>
            <T>Save</T>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setName(gateway.name);
              setRenaming(false);
            }}
          >
            <T>Cancel</T>
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{gateway.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {gateway.url} · {format} ·{" "}
              {gateway.hiddenModels.length > 0
                ? gt("{on} of {count} models on", {
                    on: gateway.modelCount,
                    count: allModels.length,
                  })
                : gt("{count, plural, one {{count} model} other {{count} models}}", {
                    count: gateway.modelCount,
                  })}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {gt("Used by {agents}", { agents })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={choosingModels}
            onClick={() => setChoosingModels(!choosingModels)}
          >
            <T>Models</T>
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setRenaming(true)}>
            <T>Rename</T>
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={confirmRemove}>
            <T>Remove</T>
          </Button>
        </div>
      )}
      {choosingModels ? (
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">
            <T>Models its agents offer. Turn one off to leave it out of the model list.</T>
          </legend>
          <div className="flex max-h-60 flex-wrap gap-2 overflow-y-auto">
            {allModels.map((model) => (
              <label
                key={model}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 has-checked:border-primary/60 has-disabled:cursor-not-allowed has-disabled:opacity-60"
              >
                <input
                  type="checkbox"
                  checked={!hiddenModels.includes(model)}
                  disabled={disabled}
                  onChange={(event) => void setModelHidden(model, !event.currentTarget.checked)}
                  className="accent-primary"
                />
                {model}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </li>
  );
}
