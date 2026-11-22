import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  customGatewayAgentsOf,
  type CustomGatewayAgent,
  type CustomGatewayFormat,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState, type FormEvent } from "react";

import { useCustomGatewayCommands } from "../../lib/customGatewayState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const formats: ReadonlyArray<{ readonly id: CustomGatewayFormat; readonly label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
];

const agents: ReadonlyArray<{ readonly id: CustomGatewayAgent; readonly label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" },
  { id: "pi", label: "Pi" },
];

/** Add a gateway by URL: its agents appear in the model picker under the name it is given. */
export function CustomGatewayForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const { canChange, add } = useCustomGatewayCommands(environmentId);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<CustomGatewayFormat>("openai");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  // Agents the user turned off; the ones the format cannot serve are off whatever is here.
  const [declined, setDeclined] = useState<ReadonlySet<CustomGatewayAgent>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The gateway's model list could not be read: the user may type the ids instead.
  const [modelsProblem, setModelsProblem] = useState<string | null>(null);
  const [models, setModels] = useState("");
  const disabled = busy || !canChange;
  const keyRequired = format === "anthropic";
  const chosen = customGatewayAgentsOf(format).filter((agent) => !declined.has(agent));

  const save = async (typed: ReadonlyArray<string> | undefined) => {
    setBusy(true);
    setError(null);
    const result = await add({
      environmentId,
      input: {
        url,
        format,
        agents: chosen,
        ...(key.trim() === "" ? {} : { key }),
        ...(name.trim() === "" ? {} : { name }),
        ...(typed === undefined ? {} : { models: typed }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(thrownErrorMessage(cause, m) || gt("Could not reach this environment."));
      return;
    }
    if (result.value.kind === "modelsProblem") {
      setModelsProblem(result.value.message);
      return;
    }
    setUrl("");
    setKey("");
    setName("");
    setModels("");
    setModelsProblem(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() === "") return;
    void save(undefined);
  };

  const typedModels = models
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter((model) => model !== "");

  return (
    <form
      onSubmit={submit}
      aria-label={gt("Custom endpoint")}
      className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-url`} className="block font-medium text-foreground">
          <T>Endpoint URL</T>
        </label>
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://gateway.example.com/v1"
          value={url}
          disabled={disabled}
          onChange={(event) => {
            setUrl(event.currentTarget.value);
            setModelsProblem(null);
          }}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="font-medium text-foreground">
          <T>Format</T>
        </legend>
        <div className="flex flex-wrap gap-2">
          {formats.map((entry) => (
            <label
              key={entry.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 has-checked:border-primary/60"
            >
              <input
                type="radio"
                name={`${id}-format`}
                value={entry.id}
                checked={format === entry.id}
                disabled={disabled}
                onChange={() => setFormat(entry.id)}
                className="accent-primary"
              />
              {entry.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={`${id}-key`} className="block font-medium text-foreground">
          {keyRequired ? <T>Key</T> : <T>Key (optional)</T>}
        </label>
        <Input
          id={`${id}-key`}
          // A CSS-masked text field still exposes its value to screen readers.
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          value={key}
          required={keyRequired}
          disabled={disabled}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="block font-medium text-foreground">
          <T>Name</T>
        </label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          placeholder={url.trim() || gt("Named after its URL")}
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="font-medium text-foreground">
          <T>Which agents should use this gateway?</T>
        </legend>
        <div className="flex flex-wrap gap-2">
          {agents.map((agent) => {
            const speaks = customGatewayAgentsOf(format).includes(agent.id);
            return (
              <label
                key={agent.id}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 has-checked:border-primary/60 has-disabled:cursor-not-allowed has-disabled:opacity-60"
              >
                <input
                  type="checkbox"
                  checked={speaks && !declined.has(agent.id)}
                  disabled={disabled || !speaks}
                  onChange={(event) => {
                    const next = new Set(declined);
                    if (event.currentTarget.checked) next.delete(agent.id);
                    else next.add(agent.id);
                    setDeclined(next);
                  }}
                  className="accent-primary"
                />
                {agent.label}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {format === "openai" ? (
            <T>Claude Code needs an Anthropic-format gateway.</T>
          ) : (
            <T>Codex needs an OpenAI-format gateway.</T>
          )}
        </p>
      </fieldset>
      <p className="text-muted-foreground">
        <T>
          The key stays on this environment. Its models are read from the endpoint's model list.
        </T>
      </p>
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
      {modelsProblem === null ? (
        <Button
          type="submit"
          size="sm"
          disabled={
            disabled ||
            url.trim() === "" ||
            chosen.length === 0 ||
            (keyRequired && key.trim() === "")
          }
        >
          {busy ? <T>Checking…</T> : <T>Add gateway</T>}
        </Button>
      ) : (
        <div className="space-y-2">
          <p role="alert" className="text-destructive-foreground">
            <T>
              Could not read the model list: <Var>{modelsProblem}</Var>
            </T>
          </p>
          <label htmlFor={`${id}-models`} className="block font-medium text-foreground">
            <T>Model ids</T>
          </label>
          <Textarea
            id={`${id}-models`}
            spellCheck={false}
            placeholder={gt("One per line, or separated by commas")}
            value={models}
            disabled={disabled}
            onChange={(event) => setModels(event.currentTarget.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || typedModels.length === 0 || chosen.length === 0}
              onClick={() => void save(typedModels)}
            >
              <T>Save with these models</T>
            </Button>
            <Button type="submit" variant="outline" size="sm" disabled={disabled}>
              <T>Try again</T>
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
