import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentdConnector,
  AgentdConnectorScope,
  AgentdConnectorServer,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { T, useGT } from "gt-react";
import { useState } from "react";

import {
  agentdEnvironment,
  useAgentdConnectors,
  useAgentdCustomizeCommands,
} from "../../lib/agentdState";
import { useEnvironmentProviders } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { AgentdLoading, AgentdReadError } from "./AgentdPageReads";
import { CustomizeListDetail, CustomizeProjectPicker } from "./CustomizeLayout";
import { parseConnectorPairs } from "./customizeConnectorForm";

type CommandResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

interface Selected {
  readonly instanceId: ProviderInstanceId;
  readonly scope: AgentdConnectorScope;
  readonly name: string;
}

function useScopeLabels(): Record<AgentdConnectorScope, string> {
  const gt = useGT();
  return {
    user: gt("All projects"),
    local: gt("This project, only you"),
    project: gt("The project's file"),
    plugin: gt("Agent plugin"),
    agentdPlugin: gt("LibraOS Next plugin"),
    managed: gt("Managed"),
  };
}

/** The host agents' own MCP servers: list, switch, add and remove, in each agent's configuration. */
export function CustomizeConnectors({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [adding, setAdding] = useState(false);
  const canChange = useAtomValue(agentdEnvironment.connectorAdd.permissionAtom(environmentId));
  const connectors = useAgentdConnectors(canChange ? environmentId : null, projectId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const scopes = useScopeLabels();
  const agentName = (instanceId: ProviderInstanceId) =>
    providers.find((provider) => provider.instanceId === instanceId)?.displayName ?? instanceId;

  if (!canChange) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
        <T>Connectors require maintain access to this environment.</T>
      </p>
    );
  }
  const data = connectors.data;
  const chosen =
    selected === null
      ? null
      : (data?.agents
          .find((agent) => agent.instanceId === selected.instanceId)
          ?.connectors.find(
            (connector) => connector.name === selected.name && connector.scope === selected.scope,
          ) ?? null);

  const list =
    connectors.error !== null ? (
      <div className="p-4">
        <AgentdReadError error={connectors.error} />
      </div>
    ) : data === null ? (
      <div className="p-4">
        <AgentdLoading />
      </div>
    ) : (
      <div className="grid gap-4 p-4">
        {data.agents.map((agent) => (
          <section key={agent.instanceId} className="grid gap-1">
            <h2 className="text-xs font-medium text-muted-foreground uppercase">
              {agentName(agent.instanceId)}
            </h2>
            {!agent.supported || agent.reason !== undefined ? (
              <p className="text-xs text-muted-foreground">
                {agent.reason ?? gt("Not supported here.")}
              </p>
            ) : null}
            {agent.supported && agent.connectors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No connectors.</T>
              </p>
            ) : null}
            <ul className="grid gap-0.5">
              {agent.connectors.map((connector) => {
                const current =
                  selected?.instanceId === agent.instanceId &&
                  selected.name === connector.name &&
                  selected.scope === connector.scope;
                return (
                  <li key={`${connector.scope}:${connector.name}`}>
                    <ConnectorRow
                      connector={connector}
                      scopeLabel={scopes[connector.scope]}
                      current={current}
                      environmentId={environmentId}
                      instanceId={agent.instanceId}
                      projectId={projectId}
                      onOpen={() =>
                        setSelected({
                          instanceId: agent.instanceId,
                          scope: connector.scope,
                          name: connector.name,
                        })
                      }
                      onChanged={connectors.refresh}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    );

  return (
    <>
      <CustomizeListDetail
        toolbar={
          <>
            <CustomizeProjectPicker
              environmentId={environmentId}
              value={projectId}
              onChange={(next) => {
                setProjectId(next);
                setSelected(null);
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="ms-auto"
              disabled={data === null || !data.agents.some((agent) => agent.supported)}
              onClick={() => setAdding(true)}
            >
              <T>Add connector</T>
            </Button>
          </>
        }
        list={list}
        detail={
          chosen === null || selected === null ? null : (
            <ConnectorDetail
              connector={chosen}
              agent={agentName(selected.instanceId)}
              scopeLabel={scopes[chosen.scope]}
              environmentId={environmentId}
              instanceId={selected.instanceId}
              projectId={projectId}
              onRemoved={() => {
                setSelected(null);
                connectors.refresh();
              }}
            />
          )
        }
        onBack={() => setSelected(null)}
      />
      {adding && data !== null ? (
        <AddConnectorDialog
          environmentId={environmentId}
          projectId={projectId}
          agents={data.agents
            .filter((agent) => agent.supported)
            .map((agent) => ({
              instanceId: agent.instanceId,
              name: agentName(agent.instanceId),
              local:
                providers.find((p) => p.instanceId === agent.instanceId)?.driver === "claudeAgent",
            }))}
          onClose={() => setAdding(false)}
          onAdded={connectors.refresh}
        />
      ) : null}
    </>
  );
}

function ConnectorRow({
  connector,
  scopeLabel,
  current,
  environmentId,
  instanceId,
  projectId,
  onOpen,
  onChanged,
}: {
  readonly connector: AgentdConnector;
  readonly scopeLabel: string;
  readonly current: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId | null;
  readonly onOpen: () => void;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const commands = useAgentdCustomizeCommands();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Claude switches a connector per project, so with no project chosen there is nothing to write.
  const switchable =
    connector.toggle === "user" || (connector.toggle === "project" && projectId !== null);
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm ${current ? "bg-accent" : ""}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 grow truncate text-start font-medium hover:underline"
          aria-current={current ? "true" : undefined}
          onClick={onOpen}
        >
          {connector.name}
        </button>
        <Badge variant="outline">{scopeLabel}</Badge>
        {connector.problem !== undefined ? (
          <Badge variant="warning">
            <T>Problem</T>
          </Badge>
        ) : null}
        <Switch
          checked={connector.enabled}
          disabled={!switchable || busy}
          aria-label={gt("Turn {name} on", { name: connector.name })}
          onCheckedChange={async (checked) => {
            setBusy(true);
            setFailure(null);
            const result: CommandResult = await commands.connectorSetEnabled({
              environmentId,
              input: {
                instanceId,
                name: connector.name,
                scope: connector.scope,
                enabled: Boolean(checked),
                ...(projectId === null ? {} : { projectId }),
              },
            });
            setBusy(false);
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              setFailure(
                error instanceof Error ? error.message : gt("The connector was not changed."),
              );
            }
            onChanged();
          }}
        />
      </div>
      {failure !== null ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
    </div>
  );
}

function ConnectorDetail({
  connector,
  agent,
  scopeLabel,
  environmentId,
  instanceId,
  projectId,
  onRemoved,
}: {
  readonly connector: AgentdConnector;
  readonly agent: string;
  readonly scopeLabel: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId | null;
  readonly onRemoved: () => void;
}) {
  const gt = useGT();
  const commands = useAgentdCustomizeCommands();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rows: Array<readonly [string, string]> = [
    [gt("Agent"), agent],
    [gt("Where"), scopeLabel],
    [gt("Transport"), connector.transport],
    ...(connector.command === undefined
      ? []
      : [[gt("Command"), [connector.command, ...(connector.args ?? [])].join(" ")] as const]),
    ...(connector.url === undefined ? [] : [[gt("URL"), connector.url] as const]),
    ...(connector.envNames.length === 0
      ? []
      : [[gt("Environment variables"), connector.envNames.join(", ")] as const]),
    ...(connector.headerNames.length === 0
      ? []
      : [[gt("Headers"), connector.headerNames.join(", ")] as const]),
    ...(connector.plugin === undefined ? [] : [[gt("Plugin"), connector.plugin] as const]),
    ...(connector.file === undefined ? [] : [[gt("Declared in"), connector.file] as const]),
  ];
  return (
    <div className="grid gap-4 text-sm">
      <h2 className="text-base font-semibold">{connector.name}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-mono text-xs wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
      {connector.problem !== undefined ? (
        <p className="text-sm text-warning-foreground">{connector.problem}</p>
      ) : null}
      {connector.scope === "agentdPlugin" ? (
        <p className="text-xs text-muted-foreground">
          <T>
            This connector comes with a LibraOS Next plugin; turn the plugin on or off under
            Plugins.
          </T>
        </p>
      ) : null}
      {connector.removable ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              const result: CommandResult = await commands.connectorRemove({
                environmentId,
                input: {
                  instanceId,
                  name: connector.name,
                  scope: connector.scope,
                  ...(projectId === null ? {} : { projectId }),
                },
              });
              setBusy(false);
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                setFailure(
                  error instanceof Error ? error.message : gt("The connector was not removed."),
                );
                return;
              }
              onRemoved();
            }}
          >
            <T>Remove</T>
          </Button>
        </div>
      ) : null}
      {failure !== null ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
    </div>
  );
}

function AddConnectorDialog({
  environmentId,
  projectId,
  agents,
  onClose,
  onAdded,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly agents: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
    readonly local: boolean;
  }>;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const gt = useGT();
  const commands = useAgentdCustomizeCommands();
  const [instanceId, setInstanceId] = useState(agents[0]?.instanceId ?? null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"user" | "local">("user");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const agent = agents.find((candidate) => candidate.instanceId === instanceId);
  const localAllowed = agent?.local === true && projectId !== null;
  const parsed = parseConnectorPairs(pairs, transport === "stdio" ? "=" : ":");
  const ready =
    instanceId !== null &&
    name.trim() !== "" &&
    parsed !== null &&
    (transport === "stdio" ? command.trim() !== "" : url.trim() !== "");

  async function submit() {
    if (!ready || instanceId === null || parsed === null) return;
    const server: AgentdConnectorServer =
      transport === "stdio"
        ? {
            transport,
            command: command.trim(),
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter((arg) => arg !== ""),
            env: parsed,
          }
        : { transport, url: url.trim(), headers: parsed };
    setBusy(true);
    setFailure(null);
    const result: CommandResult = await commands.connectorAdd({
      environmentId,
      input: {
        instanceId,
        name: name.trim(),
        scope: localAllowed ? scope : "user",
        ...(projectId === null ? {} : { projectId }),
        server,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("The connector was not added."));
      return;
    }
    onAdded();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            <T>Add connector</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              It is written to the agent's own configuration. Values you type here are not shown
              again.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label>
                <T>Agent</T>
              </Label>
              <Select
                value={instanceId ?? ""}
                onValueChange={(next) => next !== null && setInstanceId(next as ProviderInstanceId)}
              >
                <SelectTrigger aria-label={gt("Agent")} size="sm">
                  <SelectValue>{agent?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {agents.map((candidate) => (
                    <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="connector-name">
                <T>Name</T>
              </Label>
              <Input
                id="connector-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {localAllowed ? (
              <div className="grid gap-1">
                <Label>
                  <T>Where</T>
                </Label>
                <Select
                  value={scope}
                  onValueChange={(next) => next !== null && setScope(next as "user" | "local")}
                >
                  <SelectTrigger aria-label={gt("Where")} size="sm">
                    <SelectValue>
                      {scope === "user" ? gt("All projects") : gt("This project, only you")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="user">{gt("All projects")}</SelectItem>
                    <SelectItem value="local">{gt("This project, only you")}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1">
              <Label>
                <T>Transport</T>
              </Label>
              <Select
                value={transport}
                onValueChange={(next) => next !== null && setTransport(next as "stdio" | "http")}
              >
                <SelectTrigger aria-label={gt("Transport")} size="sm">
                  <SelectValue>
                    {transport === "stdio" ? gt("Command (stdio)") : gt("URL (HTTP)")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="stdio">{gt("Command (stdio)")}</SelectItem>
                  <SelectItem value="http">{gt("URL (HTTP)")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {transport === "stdio" ? (
              <>
                <div className="grid gap-1">
                  <Label htmlFor="connector-command">
                    <T>Command</T>
                  </Label>
                  <Input
                    id="connector-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="connector-args">
                    <T>Arguments, one per line</T>
                  </Label>
                  <Textarea
                    id="connector-args"
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1">
                <Label htmlFor="connector-url">
                  <T>URL</T>
                </Label>
                <Input
                  id="connector-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            )}
            <div className="grid gap-1">
              <Label htmlFor="connector-pairs">
                {transport === "stdio" ? (
                  <T>Environment variables, NAME=value per line</T>
                ) : (
                  <T>Headers, Name: value per line</T>
                )}
              </Label>
              <Textarea
                id="connector-pairs"
                value={pairs}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setPairs(event.target.value)}
              />
              {parsed === null ? (
                <p className="text-xs text-destructive-foreground">
                  <T>A line is missing its name or separator.</T>
                </p>
              ) : null}
            </div>
            {failure !== null ? (
              <p className="text-xs text-destructive-foreground">{failure}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={!ready || busy} onClick={() => void submit()}>
            <T>Add</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
