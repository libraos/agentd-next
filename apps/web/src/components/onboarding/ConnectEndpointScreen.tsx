import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { LIBRAOS_CONSOLE_API_KEYS_URL, type EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, ServerIcon, Settings2Icon } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import {
  useGatewayEnvironment,
  useLibraosGateway,
  useLibraosGatewayCommands,
} from "../../lib/libraosGatewayState";
import { AnthropicIcon, OllamaIcon, OpenAI } from "../Icons";
import { T3Wordmark } from "../T3Wordmark";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CustomGatewayForm } from "./CustomGatewayForm";
import { CustomGatewayList } from "./CustomGatewayList";

const agents = ["Claude Code", "Codex", "opencode"] as const;
type Agent = (typeof agents)[number];

const endpoints: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly agents: readonly Agent[];
  readonly Icon: typeof T3Wordmark | typeof AnthropicIcon | typeof ServerIcon;
}> = [
  { id: "gateway", label: msg("LibraOS Gateway"), agents, Icon: T3Wordmark },
  {
    id: "anthropic",
    label: msg("Anthropic API key"),
    agents: ["Claude Code", "opencode"],
    Icon: AnthropicIcon,
  },
  { id: "openai", label: msg("OpenAI API key"), agents: ["Codex", "opencode"], Icon: OpenAI },
  { id: "bedrock", label: msg("AWS Bedrock"), agents, Icon: ServerIcon },
  { id: "ollama", label: msg("Ollama"), agents, Icon: OllamaIcon },
  { id: "custom", label: msg("Custom endpoint"), agents, Icon: Settings2Icon },
];

export function ConnectEndpointScreen({
  gatewayChosen = false,
  customChosen = false,
  environmentId,
  back,
}: {
  readonly gatewayChosen?: boolean;
  /** Opens the Custom endpoint form at once: "Add gateway" in Settings. */
  readonly customChosen?: boolean;
  /** Where the Gateway is set up; the primary environment when omitted. */
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly back: ReactNode;
}) {
  const [gatewayOpen, setGatewayOpen] = useState(gatewayChosen);
  const [customOpen, setCustomOpen] = useState(customChosen);
  const gatewayEnvironment = useGatewayEnvironment(environmentId);
  const gt = useGT();
  const m = useMessages();
  const id = useId();

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <h1 className="text-center text-3xl font-semibold tracking-tight text-foreground">
        <T>Use an API key or gateway</T>
      </h1>
      <p className="text-center text-sm text-muted-foreground">
        {gatewayChosen ? (
          <>
            <T>LibraOS Gateway selected.</T> <T>Requires a LibraOS account.</T>
          </>
        ) : (
          <T>Pick where your agents get their models from.</T>
        )}
      </p>
      <ul aria-label={gt("Endpoint options")} className="space-y-2">
        {endpoints.map((endpoint) => {
          const isGateway = endpoint.id === "gateway";
          const isCustom = endpoint.id === "custom";
          const available = isGateway || isCustom;
          const selected = isGateway ? gatewayOpen : isCustom && customOpen;
          const labelId = `${id}-${endpoint.id}`;
          const descriptionId = `${labelId}-description`;
          const detail = isGateway
            ? gt("Requires a LibraOS account.")
            : isCustom
              ? gt("A gateway in OpenAI or Anthropic format.")
              : null;

          return (
            <li key={endpoint.id}>
              <button
                type="button"
                disabled={!available}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-pressed={available ? selected : undefined}
                onClick={
                  isGateway
                    ? () => setGatewayOpen((open) => !open)
                    : isCustom
                      ? () => setCustomOpen((open) => !open)
                      : undefined
                }
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left not-disabled:hover:bg-accent/50 disabled:cursor-not-allowed aria-pressed:border-primary/60"
              >
                <endpoint.Icon className="size-5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span id={labelId} className="block text-sm font-medium text-foreground">
                    {m(endpoint.label)}
                  </span>
                  <span id={descriptionId} className="block text-xs text-muted-foreground">
                    {detail === null ? null : <span className="block">{detail}</span>}
                    <span className="block">
                      {gt("For {agents}", { agents: endpoint.agents.join(", ") })}
                    </span>
                    {available ? null : <T>Not available yet</T>}
                  </span>
                </span>
                {selected ? (
                  <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {gatewayOpen ? <GatewayConnectPanel environmentId={environmentId} /> : null}
      {customOpen ? (
        gatewayEnvironment === null ? (
          <p className="text-center text-sm text-muted-foreground">
            <T>Connect to an environment first.</T>
          </p>
        ) : (
          <CustomGatewayForm environmentId={gatewayEnvironment} />
        )
      ) : null}
      {gatewayEnvironment === null ? null : (
        <CustomGatewayList environmentId={gatewayEnvironment} />
      )}
      <div className="text-center text-sm underline underline-offset-4">{back}</div>
    </div>
  );
}

const MODELS_SHOWN = 8;

/** Connect a LibraOS API key, see the models it may use, or disconnect it. */
function GatewayConnectPanel({
  environmentId: target,
}: {
  readonly environmentId: EnvironmentId | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const gateway = useLibraosGateway(target);
  const { canChange, connect, disconnect } = useLibraosGatewayCommands(gateway.environmentId);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = gateway.data;
  const environmentId = gateway.environmentId;

  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    return thrownErrorMessage(cause, m) || gt("Could not reach this environment.");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (environmentId === null || key.trim() === "") return;
    setBusy(true);
    setError(null);
    const result = await connect({ environmentId, input: { key } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failure(result));
      return;
    }
    setKey("");
  };

  const remove = async () => {
    if (environmentId === null) return;
    setBusy(true);
    setError(null);
    const result = await disconnect({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure") setError(failure(result));
  };

  if (environmentId === null) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        <T>Connect to an environment first.</T>
      </p>
    );
  }

  const errorLine =
    error === null ? null : (
      <p id={`${id}-error`} role="alert" className="text-sm text-destructive-foreground">
        {error}
      </p>
    );

  if (status?.connected) {
    const shown = status.models.slice(0, MODELS_SHOWN).map((model) => model.name ?? model.id);
    const more = status.models.length - shown.length;
    return (
      <section
        aria-label={gt("LibraOS Gateway")}
        className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
      >
        <p className="font-medium text-foreground">
          <T>LibraOS Gateway connected.</T>
        </p>
        {status.refusal ? (
          <p role="alert" className="text-destructive-foreground">
            <T>
              LibraOS Gateway refused this key, so its agents list no models:{" "}
              <Var>{status.refusal}</Var>
            </T>
          </p>
        ) : null}
        {shown.length > 0 ? (
          <p className="text-muted-foreground">
            <T>
              Models: <Var>{shown.join(", ")}</Var>
            </T>
            {more > 0 ? <> {gt("and {count} more", { count: more })}</> : null}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          {status.refusal ? (
            <T>
              Allow the key again in Console and refresh providers, or disconnect and connect
              another key.
            </T>
          ) : (
            <T>
              In a chat, choose the agent marked LibraOS Gateway in the model picker. agentd workers
              use the Gateway too, so tasks accept dollar budgets.
            </T>
          )}
        </p>
        {status.agentd === null ? null : (
          <div className="space-y-1">
            <p className="text-muted-foreground">
              {status.agentd.ok ? (
                <T>agentd is set up to use the Gateway.</T>
              ) : (
                <T>agentd did not take the key. What it said:</T>
              )}
            </p>
            {status.agentd.ok || status.agentd.output === "" ? null : (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {status.agentd.output}
              </pre>
            )}
          </div>
        )}
        {errorLine}
        <Button variant="outline" size="sm" disabled={busy || !canChange} onClick={remove}>
          <T>Disconnect</T>
        </Button>
      </section>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label={gt("LibraOS Gateway")}
      className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      <label htmlFor={`${id}-key`} className="block font-medium text-foreground">
        <T>LibraOS API key</T>
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
        placeholder="lk_…"
        value={key}
        disabled={busy || !canChange}
        aria-invalid={error !== null || undefined}
        aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(event) => setKey(event.currentTarget.value)}
      />
      <p className="text-muted-foreground">
        <T>
          Create a key on{" "}
          <a
            href={LIBRAOS_CONSOLE_API_KEYS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4"
          >
            Console's API keys page
          </a>
          . Use is billed pay as you go. The key stays on this environment.
        </T>
      </p>
      {errorLine}
      <Button type="submit" size="sm" disabled={busy || !canChange || key.trim() === ""}>
        {busy ? <T>Checking…</T> : <T>Connect</T>}
      </Button>
    </form>
  );
}
