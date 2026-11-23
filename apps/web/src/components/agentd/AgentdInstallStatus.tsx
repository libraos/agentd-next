import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdServicesProblem, AgentdStatus, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { agentdEnvironment, useAgentdCommands } from "../../lib/agentdState";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

const PATH_NOTICE_KEY = "agentd:path-notice-dismissed";
const DismissedFolder = Schema.NullOr(Schema.String);

/** Which agentd the app runs, where the desktop app installed it, and a missing PATH folder once. */
export function AgentdInstallStatus({
  status,
  environmentId,
  onRepaired,
}: {
  status: AgentdStatus;
  /** Where Repair runs; null shows the notice without it. */
  environmentId: EnvironmentId | null;
  /** Reads the status again once Repair has run. */
  onRepaired: () => void;
}) {
  const install = status.install ?? null;
  // The folder the notice was dismissed for; a different folder is reported again.
  const [dismissed, setDismissed] = useLocalStorage(PATH_NOTICE_KEY, null, DismissedFolder);
  const problem = status.servicesProblem ?? null;
  if (status.binary === undefined && install === null && problem === null) return null;
  const pathLine = install?.pathLine ?? null;
  return (
    <div className="space-y-2 border-t border-border pt-3 text-sm">
      {status.binary !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            <T>Uses</T>
          </span>
          <span className="break-all text-muted-foreground">{status.binary}</span>
        </div>
      ) : null}
      {problem !== null ? (
        <ServicesNotice problem={problem} environmentId={environmentId} onRepaired={onRepaired} />
      ) : null}
      {install !== null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            <T>Installed for the terminal</T>
          </span>
          <span className="break-all text-muted-foreground">
            {install.action === "kept-newer" || install.action === "kept-unknown" ? (
              <T>
                <Var>{install.path}</Var> (your own agentd, kept)
              </T>
            ) : (
              install.path
            )}
          </span>
        </div>
      ) : null}
      {install !== null && pathLine !== null && dismissed !== install.directory ? (
        <Alert variant="info">
          <AlertTitle>
            <T>
              <Var>{install.directory}</Var> is not on your PATH
            </T>
          </AlertTitle>
          <AlertDescription>
            <T>To run agentd in a terminal, add this line to your shell profile:</T>
            <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs">
              {pathLine}
            </code>
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => setDismissed(install.directory)}>
              <T>Got it</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}

const NOTHING_ALLOWED = Atom.make(false);

/**
 * agentd's services on a missing or old agentd, each named with its program. They are never
 * moved on their own: Repair re-registers them only once the user confirms what it changes.
 */
function ServicesNotice({
  problem,
  environmentId,
  onRepaired,
}: {
  problem: AgentdServicesProblem;
  environmentId: EnvironmentId | null;
  onRepaired: () => void;
}) {
  const gt = useGT();
  const allowed = useAtomValue(
    environmentId === null
      ? NOTHING_ALLOWED
      : agentdEnvironment.repairServices.permissionAtom(environmentId),
  );
  const { repairServices } = useAgentdCommands();
  const [confirming, setConfirming] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [failure, setFailure] = useState<{ message: string | null; command?: string } | null>(null);
  const agentd = problem.agentd;
  const command = failure?.command ?? problem.command;
  const both = problem.moves.length > 1;

  async function repair() {
    if (environmentId === null) return;
    setConfirming(false);
    setRepairing(true);
    setFailure(null);
    const result = await repairServices({ environmentId, input: { moves: problem.moves } });
    setRepairing(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure({ message: error instanceof Error ? error.message : null });
    } else if (!result.value.ok)
      setFailure({
        message: null,
        ...(result.value.command === undefined ? {} : { command: result.value.command }),
      });
    onRepaired();
  }

  return (
    <div role="status" className="space-y-1.5 text-destructive">
      {problem.services.map(({ name, program }) => (
        <p key={name} className="break-words">
          {name === "watchdog" ? (
            <T>
              AgentD’s watchdog service runs <Var>{program}</Var>, which is missing or belongs to
              the old AgentD Desktop.
            </T>
          ) : (
            <T>
              AgentD’s dashboard service runs <Var>{program}</Var>, which is missing or belongs to
              the old AgentD Desktop.
            </T>
          )}
        </p>
      ))}
      {problem.watchdogOff === true ? (
        <p>
          {allowed ? (
            <T>
              AgentD’s watchdog service runs this app’s AgentD, but systemd hasn’t turned on its
              timer, so AgentD doesn’t follow your tasks while this app is closed. Repair turns it
              on.
            </T>
          ) : (
            <T>
              AgentD’s watchdog service runs this app’s AgentD, but systemd hasn’t turned on its
              timer, so AgentD doesn’t follow your tasks while this app is closed. On that machine,
              run agentd install, then systemctl --user daemon-reload and systemctl --user enable
              --now agentd-watchdog.timer in a terminal.
            </T>
          )}
        </p>
      ) : null}
      {problem.unread !== undefined && problem.unread.length > 0 ? (
        <p>
          <T>
            AgentD couldn’t read how one of its background services is registered, and agentd
            install would rewrite it too, so Repair isn’t offered. Try again later, or run agentd
            install in a terminal with the AgentD you use.
          </T>
        </p>
      ) : null}
      {problem.overridden !== undefined && problem.overridden.length > 0 ? (
        <p>
          <T>
            A systemd drop-in sets the program this service runs, and agentd install doesn’t change
            drop-ins, so Repair isn’t offered for it. Remove the ExecStart lines from the drop-in in
            ~/.config/systemd/user and run systemctl --user daemon-reload. Then, in a terminal with
            the AgentD you use, run agentd install for the watchdog or agentd dash install for the
            dashboard.
          </T>
        </p>
      ) : null}
      {problem.kept !== undefined && problem.kept.length > 0 ? (
        <p>
          <T>
            One of AgentD’s background services runs an AgentD that is missing or belongs to the old
            AgentD Desktop, and another runs your own AgentD. This app left both alone: run agentd
            install with the AgentD you use. It rewrites both services with the AGENTD_ROOT and
            AGENTD_DB set where you run it; if the dashboard uses its own, run agentd dash install
            with those afterwards.
          </T>
        </p>
      ) : agentd === null ? (
        <p>
          <T>
            AgentD’s background services run an AgentD that is missing or belongs to the old AgentD
            Desktop. This app’s AgentD is gone once the app closes, so they were left alone: install
            agentd for the terminal, then run agentd install.
          </T>
        </p>
      ) : null}
      {command !== undefined ? (
        <>
          <p>
            <T>
              AgentD’s background services aren’t running this app’s AgentD yet: AgentD won’t start
              them while older AgentD services are on. Run this, then agentd install, in a terminal.
            </T>
          </p>
          <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs text-foreground">
            {command}
          </code>
        </>
      ) : failure !== null ? (
        <p>
          {failure.message ??
            (problem.services.length === 0 && problem.watchdogOff === true
              ? gt(
                  "Turning on AgentD’s watchdog timer failed. Try Repair again, or run systemctl --user enable --now agentd-watchdog.timer in a terminal.",
                )
              : gt(
                  "AgentD’s background services run an AgentD that is missing or belongs to the old AgentD Desktop, and moving them to this app’s AgentD failed. Run agentd install in a terminal.",
                ))}
        </p>
      ) : null}
      {agentd !== null && problem.moves.length > 0 && allowed ? (
        <Button
          size="sm"
          variant="outline"
          disabled={repairing}
          onClick={() => setConfirming(true)}
        >
          {repairing ? <T>Repairing…</T> : <T>Repair…</T>}
        </Button>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Repair AgentD’s background services?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {both ? (
                <T>
                  This runs agentd install from this app’s AgentD (<Var>{agentd}</Var>), and on
                  Linux agentd dash install too. It re-registers both the dashboard and the watchdog
                  with this app’s AgentD and the root this app uses; an AGENTD_ROOT or AGENTD_DB
                  they set now isn’t kept.
                </T>
              ) : problem.moves[0] === "dash" ? (
                <T>
                  This runs agentd dash install from this app’s AgentD (<Var>{agentd}</Var>). It
                  re-registers the dashboard with this app’s AgentD and the root this app uses; an
                  AGENTD_ROOT or AGENTD_DB it sets now isn’t kept.
                </T>
              ) : (
                <T>
                  This runs agentd install from this app’s AgentD (<Var>{agentd}</Var>). It
                  re-registers the watchdog with this app’s AgentD and the root this app uses; an
                  AGENTD_ROOT or AGENTD_DB it sets now isn’t kept.
                </T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button onClick={() => void repair()}>
              <T>Repair</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
