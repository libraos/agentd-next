import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdPluginListing, EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { T, useGT } from "gt-react";
import { useState } from "react";

import {
  agentdEnvironment,
  useAgentdPluginCommands,
  useAgentdPlugins,
} from "../../lib/agentdState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AgentdLoading, AgentdReadError } from "./AgentdPageReads";

/** The AgentD page's plugins: install, turn on or off, and remove those from our catalogue. */
export function AgentdPagePlugins({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const plugins = useAgentdPlugins(environmentId);
  const canChange = useAtomValue(agentdEnvironment.pluginsInstall.permissionAtom(environmentId));
  if (plugins.error !== null) return <AgentdReadError error={plugins.error} />;
  const data = plugins.data;
  if (data === null) return <AgentdLoading />;
  if (data.plugins.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {data.source === "none" ? (
          <T>The plugin catalogue could not be reached.</T>
        ) : (
          <T>The catalogue has no plugins yet.</T>
        )}
      </p>
    );
  return (
    <ul className="space-y-3">
      {data.plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          environmentId={environmentId}
          canChange={canChange}
          onChanged={plugins.refresh}
        />
      ))}
    </ul>
  );
}

function PluginRow({
  plugin,
  environmentId,
  canChange,
  onChanged,
}: {
  readonly plugin: AgentdPluginListing;
  readonly environmentId: EnvironmentId;
  readonly canChange: boolean;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const commands = useAgentdPluginCommands();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const installed = plugin.installedVersion !== undefined;
  const update = installed && plugin.installedVersion !== plugin.version;

  async function run(
    action: () => Promise<
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
    >,
  ) {
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("The plugin was not changed."));
    }
    onChanged();
  }

  const input = { id: plugin.id };
  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{plugin.name}</span>
        <span className="text-muted-foreground">{plugin.installedVersion ?? plugin.version}</span>
        {plugin.state === "missing" ? (
          <Badge variant="error">
            <T>Hook missing: sends stop</T>
          </Badge>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          {installed ? (
            <Switch
              checked={plugin.enabled}
              disabled={!canChange || busy}
              aria-label={gt("Turn {name} on", { name: plugin.name })}
              onCheckedChange={(checked) =>
                void run(() =>
                  commands.setEnabled({
                    environmentId,
                    input: { ...input, enabled: Boolean(checked) },
                  }),
                )
              }
            />
          ) : null}
          {!installed || update ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canChange || busy}
              onClick={() => void run(() => commands.install({ environmentId, input }))}
            >
              {update ? <T>Update</T> : <T>Install</T>}
            </Button>
          ) : null}
          {installed ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canChange || busy}
              onClick={() => void run(() => commands.remove({ environmentId, input }))}
            >
              <T>Remove</T>
            </Button>
          ) : null}
        </div>
      </div>
      {plugin.description === "" ? null : (
        <p className="text-muted-foreground">{plugin.description}</p>
      )}
      {plugin.author === "" ? null : (
        <p className="text-muted-foreground text-xs">
          {gt("By {author} · {licence}", { author: plugin.author, licence: plugin.licence })}
        </p>
      )}
      {failure === null ? null : (
        <p role="alert" className="text-destructive wrap-anywhere">
          {failure}
        </p>
      )}
    </li>
  );
}
