import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdGitIdentity, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";

import { agentdEnvironment, useAgentdCommands } from "~/lib/agentdState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const IDENTITY_LIMIT = 200;

/** Sets the global Git name and email a worker commits with, then reads them back. */
export function GitIdentitySetup({
  environmentId,
  identity,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly identity: AgentdGitIdentity;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const canSave = useAtomValue(agentdEnvironment.setGitIdentity.permissionAtom(environmentId));
  const { setGitIdentity } = useAgentdCommands();
  const [name, setName] = useState(identity.name);
  const [email, setEmail] = useState(identity.email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = name.trim() !== "" && email.trim() !== "";

  async function save() {
    if (!filled || saving) return;
    setSaving(true);
    setError(null);
    const result = await setGitIdentity({
      environmentId,
      input: { name: name.trim(), email: email.trim() },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Git could not save them."));
      return;
    }
    onSaved();
  }

  return (
    <form
      className="min-w-0 space-y-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm">
        <T>Git puts this name and email on the worker’s commits, in every repository here.</T>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-name`}>{gt("Your name")}</Label>
          <Input
            id={`${id}-name`}
            autoComplete="name"
            maxLength={IDENTITY_LIMIT}
            disabled={!canSave || saving}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-email`}>{gt("Your email")}</Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            maxLength={IDENTITY_LIMIT}
            disabled={!canSave || saving}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
      {canSave ? (
        <Button type="submit" size="sm" disabled={!filled || saving}>
          {saving ? <T>Saving…</T> : <T>Save</T>}
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">
          <T>This connection cannot change this computer’s Git settings.</T>
        </p>
      )}
    </form>
  );
}
