import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdPluginListing, EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import {
  agentdEnvironment,
  useAgentdPluginCommands,
  useAgentdPlugins,
} from "../../lib/agentdState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AgentdPluginContributions } from "./AgentdPluginContributions";
import { AgentdLoading, AgentdReadError } from "./AgentdPageReads";

const SETUP_POLL_MS = 2_000;

/** The AgentD page's plugins: install, turn on or off, and remove those from our catalogue. */
export function AgentdPagePlugins({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const plugins = useAgentdPlugins(environmentId);
  const canChange = useAtomValue(agentdEnvironment.pluginsInstall.permissionAtom(environmentId));
  const settingUp = plugins.data?.plugins.some((plugin) => plugin.setup?.status === "running");
  const refresh = plugins.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- setup runs on the server; poll its progress only while it runs.
  useEffect(() => {
    if (settingUp !== true) return;
    const timer = window.setInterval(refresh, SETUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [settingUp, refresh]);
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
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const setup = plugin.setup;
  const setUp = setup === undefined || setup.status === "ready";
  const settingUp = setup?.status === "running";
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
        {plugin.state === "missing" && setUp && plugin.hooks.length > 0 ? (
          <Badge variant="error">
            <T>Hook missing: sends stop</T>
          </Badge>
        ) : null}
        {setup?.status === "needed" ? (
          <Badge variant="warning">
            <T>Needs setup</T>
          </Badge>
        ) : setup?.status === "running" ? (
          <Badge variant="info">
            <T>Setting up</T>
          </Badge>
        ) : setup?.status === "failed" ? (
          <Badge variant="error">
            <T>Setup failed</T>
          </Badge>
        ) : setup?.status === "ready" ? (
          <Badge variant="success">
            <T>Ready</T>
          </Badge>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          {installed ? (
            <Switch
              checked={plugin.enabled}
              disabled={!canChange || busy || (!setUp && !plugin.enabled)}
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
          {installed && setup !== undefined ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canChange || busy || settingUp}
              onClick={() => void run(() => commands.setup({ environmentId, input }))}
            >
              {setup.status === "needed" ? <T>Set up</T> : <T>Set up again</T>}
            </Button>
          ) : null}
          {installed ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canChange || busy || settingUp}
              onClick={() =>
                setup === undefined
                  ? void run(() => commands.remove({ environmentId, input }))
                  : setConfirmingRemove(true)
              }
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
      {setup === undefined || setup.status === "ready" ? null : (
        <p className="text-muted-foreground">{setup.description}</p>
      )}
      {installed ? (
        <AgentdPluginContributions
          plugin={plugin}
          disabled={!canChange || busy}
          onSave={(values) =>
            void run(() => commands.setSettings({ environmentId, input: { ...input, values } }))
          }
        />
      ) : null}
      {setup?.status === "running" ? (
        <p aria-live="polite" className="text-muted-foreground text-xs wrap-anywhere">
          {setup.progress ?? gt("Starting setup…")}
        </p>
      ) : null}
      {setup?.status === "failed" && setup.reason !== undefined ? (
        <p className="text-destructive wrap-anywhere">{setup.reason}</p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-destructive wrap-anywhere">
          {failure}
        </p>
      )}
      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Remove {name}?", { name: plugin.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its data folder holds what its setup downloaded. Keep it to set up faster after
                installing again, or delete it to free the disk.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmingRemove(false);
                void run(() => commands.remove({ environmentId, input }));
              }}
            >
              <T>Remove, keep data</T>
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingRemove(false);
                void run(() =>
                  commands.remove({ environmentId, input: { ...input, deleteData: true } }),
                );
              }}
            >
              <T>Remove and delete data</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}
