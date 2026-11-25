import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useLocale, Var } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { type FormEvent, type MouseEvent, useId, useRef, useState } from "react";

import { isElectron } from "../../env";
import { agentdEnvironment } from "../../lib/agentdState";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { CommandBlock } from "../CommandBlock";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const CONSOLE_URL = "https://console.libraos.com/agentd";
// agentd's own default Job API; any other is a separately hosted one with its own keys.
const LIBRAOS_JOB_API = "https://cloud-api.libraos.com";

function CloudWorkersSetupLink() {
  return (
    <a href={CONSOLE_URL} target="_blank" rel="noreferrer" className="underline">
      <T>Open Cloud Workers setup in LibraOS Console</T>
    </a>
  );
}

function ConsoleButton() {
  // The desktop opens Console in the system browser; the web build follows the link.
  const open = isElectron
    ? (event: MouseEvent) => {
        event.preventDefault();
        void ensureLocalApi().shell.openExternal(CONSOLE_URL);
      }
    : undefined;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" />}
      onClick={open}
    >
      <T>Create a key in LibraOS Console</T>
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}

/**
 * Set up Cloud Workers: create an account key in Console, paste it, and agentd installs it with
 * `agentd cloud setup`. The key is read from the field at submit and kept in no React state, and
 * goes only to the Job API shown here.
 */
export function CloudWorkersSetup({
  environmentId,
  canConfigure,
  setupUrl,
  onConfigured,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  /** agentd has `cloud setup` (v0.1.15+); older agentd keeps the Console link. */
  readonly canConfigure: boolean;
  /** The Job API agentd would send the key to; no key is asked for while it is unknown. */
  readonly setupUrl: string | null | undefined;
  readonly onConfigured?: () => void;
  /** Shown as "Keep the current key"; unavailable once a replacement is sent. */
  readonly onCancel?: (() => void) | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const allowed = useAtomValue(agentdEnvironment.cloudConfigure.permissionAtom(environmentId));
  const configure = useAtomCommand(agentdEnvironment.cloudConfigure, {
    reportFailure: false,
    reportDefect: false,
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly ok: true; readonly balanceUsd: number | null }
    | { readonly ok: false; readonly reason: string }
    | null
  >(null);

  if (!canConfigure) {
    return (
      <div className="space-y-1.5 text-xs">
        <CloudWorkersSetupLink />
        <p>
          <T>
            To set up Cloud Workers here, LibraOS Engine needs an upgrade. Run this, then reopen
            this view:
          </T>
        </p>
        <CommandBlock command="libraos-core upgrade" />
      </div>
    );
  }
  if (!setupUrl) {
    return (
      <div className="space-y-1 text-xs">
        <p>
          <T>
            LibraOS Engine didn’t say where it would send an account key, so none is asked for here.
          </T>
        </p>
        <CloudWorkersSetupLink />
      </div>
    );
  }
  const destination = setupUrl;
  const libraos = destination.replace(/\/+$/, "") === LIBRAOS_JOB_API;
  if (!allowed) {
    return (
      <div className="space-y-1 text-xs">
        <p>
          <T>This connection can’t set up Cloud Workers.</T>
        </p>
        <CloudWorkersSetupLink />
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = field.current;
    const key = input?.value.trim() ?? "";
    if (input === null || key === "" || busy) return;
    input.value = "";
    setBusy(true);
    setOutcome(null);
    const result = await configure({ environmentId, input: { key, url: destination } });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setOutcome({
        ok: false,
        reason:
          cause instanceof Error && cause.message
            ? cause.message.replaceAll(key, "[redacted]")
            : gt("LibraOS Engine couldn’t set up Cloud Workers."),
      });
      return;
    }
    setOutcome({ ok: true, balanceUsd: result.value.balanceUsd });
    onConfigured?.();
  }

  const balance =
    outcome?.ok === true && outcome.balanceUsd !== null
      ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          outcome.balanceUsd,
        )
      : null;
  return (
    <form className="space-y-2 text-xs" autoComplete="off" onSubmit={submit}>
      <p className="font-medium">
        <T>Set up Cloud Workers</T>
      </p>
      <ol className="list-decimal space-y-1 ps-4">
        <li>
          {libraos ? (
            <T>Create a Cloud Workers account key in LibraOS Console.</T>
          ) : (
            <T>
              Get an account key from whoever runs the Job API at <Var>{setupUrl}</Var>. A LibraOS
              Console key won’t work there.
            </T>
          )}
        </li>
        <li>
          <T>
            Paste the key here. LibraOS Engine sends it to <Var>{setupUrl}</Var> to check it, then
            saves it in a private file on this environment’s machine.
          </T>
        </li>
      </ol>
      {libraos ? <ConsoleButton /> : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-key`}>
          <T>Cloud Workers account key</T>
        </Label>
        <Input
          nativeInput
          id={`${id}-key`}
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={busy}
          aria-invalid={outcome?.ok === false}
          onChange={() => setOutcome(null)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="xs" disabled={busy}>
          {busy ? <T>Setting up…</T> : <T>Set up Cloud Workers</T>}
        </Button>
        {onCancel ? (
          // Once sent, the new key is installed if it checks out: there is no keeping the old one.
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
            <T>Keep the current key</T>
          </Button>
        ) : null}
      </div>
      {outcome?.ok === true ? (
        <p role="status">
          {balance === null ? (
            <T>Cloud Workers are set up.</T>
          ) : (
            <T>
              Cloud Workers are set up. Available LibraOS credit: <Var>{balance}</Var>
            </T>
          )}
        </p>
      ) : outcome?.ok === false ? (
        <p role="alert" className="wrap-anywhere text-destructive">
          {outcome.reason}
        </p>
      ) : null}
    </form>
  );
}
