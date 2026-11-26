import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdPlugins, EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useAgentdPluginCommands } from "../../lib/agentdState";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

type CommandResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

/**
 * The catalogues plugins come from: the official one, which always stays, and GitHub repositories
 * a person adds, with a token for a private one. Below them, developer mode and its local folders.
 */
export function AgentdPluginSources({
  data,
  environmentId,
  canChange,
  onChanged,
}: {
  readonly data: AgentdPlugins;
  readonly environmentId: EnvironmentId;
  readonly canChange: boolean;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const commands = useAgentdPluginCommands();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  async function run(action: () => Promise<CommandResult>, after?: () => void) {
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("Nothing was changed."));
    } else after?.();
    onChanged();
  }

  return (
    <div className="mb-4 flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="font-medium">
          <T>Catalogues</T>
        </span>
        <ul className="flex flex-col gap-1">
          {data.sources.map((source) => (
            <li key={source.repository} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{source.repository}</span>
              {source.official ? (
                <Badge variant="outline">
                  {gt("Official", { $context: "plugin source: the LibraOS catalogue" })}
                </Badge>
              ) : source.hasToken ? (
                <Badge variant="info">
                  <T>Private, token kept</T>
                </Badge>
              ) : null}
              {source.state === "none" ? (
                <Badge variant="error">
                  <T>Could not be reached</T>
                </Badge>
              ) : null}
              {source.official ? null : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ms-auto"
                  disabled={!canChange || busy}
                  onClick={() => setRemoving(source.repository)}
                >
                  {gt("Remove {repository}", { repository: source.repository })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {canChange ? (
        <form
          className="flex flex-col gap-2 rounded-md border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const given = token.trim();
            void run(
              () =>
                commands.addSource({
                  environmentId,
                  input: given.length === 0 ? { repository } : { repository, token: given },
                }),
              () => {
                setRepository("");
                setToken("");
              },
            );
          }}
        >
          <p className="text-muted-foreground text-xs">
            <T>
              Add your organisation's catalogue: a GitHub repository with a catalog.json in the same
              format. A private one needs a read-only token for that repository (fine-grained,
              Contents: read). The token stays on this computer and is sent only to GitHub for that
              repository.
            </T>
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="plugin-source-repository">
              <T>Repository</T>
            </Label>
            <Input
              id="plugin-source-repository"
              placeholder="owner/plugins"
              value={repository}
              disabled={busy}
              onChange={(event) => setRepository(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="plugin-source-token">
              <T>Token (private repositories only)</T>
            </Label>
            <Input
              id="plugin-source-token"
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="xs"
            variant="outline"
            className="self-start"
            disabled={busy || repository.trim().length === 0}
          >
            <T>Add catalogue</T>
          </Button>
        </form>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="plugin-developer-mode"
            checked={data.developerMode}
            disabled={!canChange || busy}
            onCheckedChange={(checked) =>
              void run(() =>
                commands.setDeveloperMode({ environmentId, input: { enabled: Boolean(checked) } }),
              )
            }
          />
          <Label htmlFor="plugin-developer-mode">
            <T>Developer mode</T>
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">
          <T>
            For writing a plugin: add a folder on this computer as a plugin. It is not pinned to a
            commit and is read again each time it is used.
          </T>
        </p>
        {data.developerMode && canChange ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () => commands.addLocal({ environmentId, input: { path: folder } }),
                () => setFolder(""),
              );
            }}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor="plugin-local-folder">
                <T>Plugin folder (full path)</T>
              </Label>
              <Input
                id="plugin-local-folder"
                value={folder}
                disabled={busy}
                onChange={(event) => setFolder(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={busy || folder.trim().length === 0}
            >
              <T>Add folder</T>
            </Button>
          </form>
        ) : null}
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-destructive whitespace-pre-line wrap-anywhere">
          {failure}
        </p>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Remove the catalogue {repository}?", { repository: removing ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its plugins are no longer offered and its token is deleted. Plugins already
                installed from it stay until you remove them.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target !== null) {
                  void run(() =>
                    commands.removeSource({ environmentId, input: { repository: target } }),
                  );
                }
              }}
            >
              <T>Remove catalogue</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
