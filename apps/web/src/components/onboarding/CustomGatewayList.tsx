import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  defaultGatewayName,
  type CustomGatewayAgent,
  type CustomGatewayMediaKind,
  type CustomGatewaySummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, msg, useGT, useMessages } from "gt-react";
import { useId, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useCustomGatewayCommands, useCustomGateways } from "../../lib/customGatewayState";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** The environment's custom gateways, each with its models, Rename and Remove. Nothing while there are none. */
const AGENT_LABELS: Record<CustomGatewayAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  pi: "Pi",
};

const MEDIA_KIND_LABELS: Record<CustomGatewayMediaKind, string> = {
  video: msg("Video", { $context: "kind of AI model" }),
  image: msg("Image", { $context: "kind of AI model" }),
  audio: msg("Audio", { $context: "kind of AI model" }),
  other: msg("Embedding or other", { $context: "kind of AI model" }),
};

export function CustomGatewayList({
  environmentId,
  heading = true,
}: {
  readonly environmentId: EnvironmentId;
  /** Off where a heading above already says Your gateways. */
  readonly heading?: boolean;
}) {
  const gt = useGT();
  const { data } = useCustomGateways(environmentId);
  const gateways = data?.gateways ?? [];
  if (gateways.length === 0) return null;
  return (
    <section aria-label={gt("Your gateways")} className="space-y-2">
      {heading ? (
        <h2 className="text-sm font-medium text-foreground">
          <T>Your gateways</T>
        </h2>
      ) : null}
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
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
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
  const agents = gateway.agents
    .map((agent) => {
      const provider = providers.find(
        (candidate) => candidate.instanceId === `gw-${gateway.id}-${agent}`,
      );
      // The model list shows this agent's source as needing it; say why here too.
      return provider?.enabled && !provider.installed && provider.status === "error"
        ? gt("{agent} (not installed)", { agent: AGENT_LABELS[agent] })
        : AGENT_LABELS[agent];
    })
    .join(", ");

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
            placeholder={defaultGatewayName(gateway.url)}
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
            {gateway.mediaModels.length > 0 ? (
              <p className="truncate text-xs text-muted-foreground">
                {gt(
                  "{count, plural, one {{count} more model is not for chat. See Models.} other {{count} more models are not for chat. See Models.}}",
                  { count: gateway.mediaModels.length },
                )}
              </p>
            ) : null}
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
      {choosingModels && gateway.mediaModels.length > 0 ? (
        <section aria-label={gt("Not for chat")} className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {gt(
              "{count, plural, one {{count} model on this gateway makes video, images, audio or vectors, so no agent can chat with it.} other {{count} models on this gateway make video, images, audio or vectors, so no agent can chat with them.}}",
              { count: gateway.mediaModels.length },
            )}{" "}
            <T>
              Ask an agent in a thread for a video, speech, sound or a transcript and it uses the
              video and audio ones. Image and embedding models are not supported yet.
            </T>
          </p>
          <ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {gateway.mediaModels.map((model) => (
              <li
                key={model.id}
                className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-muted-foreground"
              >
                <span>{model.id}</span>
                <span className="text-xs">{m(MEDIA_KIND_LABELS[model.kind])}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </li>
  );
}
