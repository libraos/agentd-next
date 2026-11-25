import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentdPermissionMode, AgentdSetupState, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  agentdEnvironment,
  useAgentdCloudAccount,
  useAgentdEula,
  useAgentdSetup,
  useAgentdStatus,
} from "~/lib/agentdState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AgreementMarkdown } from "./AgreementMarkdown";
import { installAgentdBeforeSetup } from "./agentdSetupInstall.logic";
import { offerAccountLink } from "./agentdVisibility.logic";
import { CloudWorkersSetup } from "./CloudWorkersSetup";
import { PermissionModeChoice } from "./WorkerPermissionMode";

const EULA_URL = "https://libraos.com/eula";

// On a short window the benefit lines would push the agreement off screen, so it starts open.
function openAgreementFirst() {
  return typeof window !== "undefined" && window.matchMedia("(max-height: 640px)").matches;
}

// The environment the person opened the dialog for, and those they answered Not now for, this run.
const openedFor = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:setup-dialog"),
);
// The environment the person asked to link a LibraOS account for, from the indicator or Settings.
const linkOpenedFor = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:link-dialog"),
);
const notNow = Atom.make<Readonly<Record<EnvironmentId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:setup-not-now"),
);

/** Opens Set up AgentD for an environment, as the AgentD page's not-set-up message does. */
export function openAgentdSetupDialog(environmentId: EnvironmentId) {
  appAtomRegistry.set(openedFor, environmentId);
}

/** Opens the link step alone, with the same Cloud Workers key form as after setup. */
export function openAgentdLinkDialog(environmentId: EnvironmentId) {
  appAtomRegistry.set(linkOpenedFor, environmentId);
}

export function useCanSetUpAgentd(environmentId: EnvironmentId | null) {
  return useAtomValue(agentdEnvironment.setupStart.permissionAtom(environmentId));
}

function closeDialog(environmentId: EnvironmentId) {
  appAtomRegistry.set(openedFor, null);
  appAtomRegistry.set(linkOpenedFor, null);
  appAtomRegistry.set(notNow, { ...appAtomRegistry.get(notNow), [environmentId]: true });
}

/**
 * Where the app opens: shows the dialog by itself when the primary environment's agentd says it
 * is not set up, until Not now; and whenever the AgentD page asks for it.
 */
export function AgentdSetupDialogHost() {
  const opened = useAtomValue(openedFor);
  const linkOnly = useAtomValue(linkOpenedFor);
  const dismissed = useAtomValue(notNow);
  const primary = usePrimaryEnvironmentId();
  const status = useAgentdStatus(primary);
  const canSetUp = useCanSetUpAgentd(primary);
  const automatic =
    primary !== null && status.data?.setUp === false && canSetUp && dismissed[primary] !== true
      ? primary
      : null;
  if (opened === null && linkOnly !== null)
    return <AgentdSetupDialog key={`link:${linkOnly}`} environmentId={linkOnly} linkOnly />;
  const environmentId = opened ?? automatic;
  return environmentId === null ? null : (
    <AgentdSetupDialog key={environmentId} environmentId={environmentId} linkOnly={false} />
  );
}

function AgentdSetupDialog({
  environmentId,
  linkOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly linkOnly: boolean;
}) {
  const gt = useGT();
  const eula = useAgentdEula(environmentId);
  const setup = useAgentdSetup(environmentId);
  const status = useAgentdStatus(environmentId);
  const canSetUp = useCanSetUpAgentd(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const startSetup = useAtomCommand(agentdEnvironment.setupStart, { reportFailure: false });
  // The run this dialog's Accept started; "starting" until the server names it.
  const [attempt, setAttempt] = useState<number | "starting" | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Asked at first setup only, with neither choice made; agentd keeps the answer, the app does not.
  const [permissionMode, setPermissionMode] = useState<AgentdPermissionMode | null>(null);
  const askPermissionMode = status.data?.firstSetup === true;
  const run = setup.data;
  const ours = run !== null && run.attempt === attempt ? run : null;
  // A run another client started is shown too; an old finished one only if it failed.
  const setUpNow = status.data?.setUp === true;
  // A failure older than this dialog is moot once agentd says it is set up, as after init in a terminal.
  const shown: AgentdSetupState | null =
    ours ??
    (run !== null && (run.phase === "running" || (run.phase === "failed" && !setUpNow))
      ? run
      : null);
  const running = attempt === "starting" || shown?.phase === "running";
  const finished = ours?.phase === "succeeded" || ours?.phase === "failed";
  const succeeded = ours?.phase === "succeeded";
  const refreshStatus = status.refresh;
  // After setup, or when asked for alone, the dialog offers linking the LibraOS account.
  const alreadySetUp = attempt === null && setUpNow && shown === null;
  const linkStep = linkOnly || succeeded || alreadySetUp;
  const account = useAgentdCloudAccount(linkStep ? environmentId : null);
  const offerLink = account.error !== null ? false : offerAccountLink(account.data);
  // The person linked in this dialog: it stays to show the result until they close it.
  const [linkedHere, setLinkedHere] = useState(false);
  const refreshAccount = account.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- agentd may have been set up in a terminal since its status was read
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads agentd's status and account once the server's init run ends
  useEffect(() => {
    if (!finished) return;
    refreshStatus();
    if (succeeded) refreshAccount();
  }, [finished, succeeded, refreshStatus, refreshAccount]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes once agentd says there is nothing to link: a linked account never sees the step
  useEffect(() => {
    if (linkStep && offerLink === false && !linkedHere) closeDialog(environmentId);
  }, [linkStep, offerLink, linkedHere, environmentId]);

  if (linkStep) {
    const setup = account.data;
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog(environmentId);
        }}
      >
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {succeeded || alreadySetUp ? (
                <T>LibraOS Engine is set up</T>
              ) : (
                <T>Link your LibraOS account</T>
              )}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {setup === null || (offerLink !== true && !linkedHere) ? (
              <p role="status" className="text-muted-foreground text-sm">
                <T>Checking your LibraOS account…</T>
              </p>
            ) : (
              <div className="space-y-3">
                {ours?.permissionModeIgnored === true ? (
                  <p className="text-muted-foreground text-sm">
                    <T>
                      This version of LibraOS Engine could not take your choice about background
                      workers, so they ask first. See Settings → Workers.
                    </T>
                  </p>
                ) : null}
                <p className="text-sm">
                  <T>Optional: link your LibraOS account to run tasks on Cloud Workers.</T>
                </p>
                <CloudWorkersSetup
                  environmentId={environmentId}
                  canConfigure={setup.canConfigure === true}
                  setupUrl={setup.setupUrl}
                  onConfigured={() => {
                    setLinkedHere(true);
                    refreshAccount();
                  }}
                />
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeDialog(environmentId)}>
              {linkedHere ? <T>Done</T> : <T>Skip</T>}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  const accept = async () => {
    // From here the dialog stays until the person closes it, whatever the status says.
    appAtomRegistry.set(openedFor, environmentId);
    setAttempt("starting");
    setStartError(null);
    await installAgentdBeforeSetup({
      environmentId,
      primaryEnvironmentId,
      bridge: window.desktopBridge,
    });
    const result = await startSetup({
      environmentId,
      input: askPermissionMode && permissionMode !== null ? { permissionMode } : {},
    });
    if (result._tag === "Success") {
      setAttempt(result.value.attempt);
    } else {
      const failure = squashAtomCommandFailure(result);
      setAttempt(null);
      setStartError(
        failure instanceof Error && failure.message
          ? failure.message
          : gt("LibraOS Engine could not start libraos-core init."),
      );
    }
  };

  const stoppedReason =
    shown?.stopped === "prompt"
      ? gt(
          "libraos-core init asked a question this app does not answer, so it was stopped. Run libraos-core init in a terminal to answer it.",
        )
      : shown?.stopped === "timeout"
        ? gt("libraos-core init took longer than 10 minutes and was stopped.")
        : shown?.stopped === "spawn"
          ? gt("libraos-core init could not be started.")
          : shown?.phase === "failed"
            ? gt("libraos-core init did not finish (exit code {code}). What it said is above.", {
                code: String(shown.exitCode ?? "?"),
              })
            : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) closeDialog(environmentId);
      }}
    >
      <DialogPopup showCloseButton={!running} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Set up LibraOS Engine</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {shown === null ? (
              <>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  <li>
                    <T>
                      Hand a task to a worker with a goal, a check and a budget, and keep working
                      while it runs.
                    </T>
                  </li>
                  <li>
                    <T>Run it on this machine, a team machine or in the cloud.</T>
                  </li>
                  <li>
                    <T>See results, approvals and cost in one place.</T>
                  </li>
                </ul>
                <p className="text-sm">
                  <T>Chat and Code work without it.</T>
                </p>
                <Collapsible defaultOpen={openAgreementFirst()}>
                  <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                    <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
                    {eula.data?.version ? (
                      <T>
                        Read the agreement (version <Var>{eula.data.version}</Var>)
                      </T>
                    ) : (
                      <T>Read the agreement</T>
                    )}
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="mt-2 space-y-2">
                      {eula.error ? (
                        <p role="alert" className="text-destructive text-sm">
                          <T>
                            Couldn&apos;t read the agreement from LibraOS Engine:{" "}
                            <Var>{eula.error}</Var>
                          </T>
                        </p>
                      ) : (
                        <div
                          role="document"
                          aria-label={gt("LibraOS Engine End User Agreement")}
                          tabIndex={0}
                          className="max-h-72 overflow-y-auto rounded-lg border border-border p-3"
                        >
                          {eula.data?.text ? (
                            <AgreementMarkdown text={eula.data.text} />
                          ) : (
                            <p className="text-xs">{gt("Loading…")}</p>
                          )}
                        </div>
                      )}
                      <p className="text-muted-foreground text-sm">
                        <T>
                          Also at{" "}
                          <a
                            className="underline"
                            href={EULA_URL}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            libraos.com/eula
                          </a>
                          .
                        </T>
                      </p>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
                {askPermissionMode ? (
                  <PermissionModeChoice
                    value={permissionMode}
                    onChange={setPermissionMode}
                    disabled={!canSetUp}
                  />
                ) : null}
                <p className="text-muted-foreground text-xs">
                  <T>
                    Accept records that you accept the LibraOS Engine End User Agreement and runs{" "}
                    <code>libraos-core init</code> on this environment.
                  </T>
                </p>
                {!canSetUp && (
                  <p className="text-muted-foreground text-sm">
                    <T>This connection cannot set up LibraOS Engine on this environment.</T>
                  </p>
                )}
              </>
            ) : (
              <>
                <p role="status" className="font-medium text-sm">
                  {running ? <T>Setting up LibraOS Engine…</T> : <T>libraos-core init stopped</T>}
                </p>
                <div
                  role="log"
                  aria-label={gt("libraos-core init output")}
                  className="max-h-72 overflow-y-auto rounded-lg border border-border p-3"
                >
                  <pre className="wrap-anywhere whitespace-pre-wrap font-mono text-xs">
                    {shown.output === "" ? gt("Starting libraos-core init…") : shown.output}
                  </pre>
                </div>
                {stoppedReason !== null && (
                  <p role="alert" className="text-destructive text-sm">
                    {stoppedReason}
                  </p>
                )}
              </>
            )}
            {startError !== null && (
              <p role="alert" className="wrap-anywhere text-destructive text-sm">
                {startError}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={running}
            onClick={() => closeDialog(environmentId)}
          >
            {shown?.phase === "failed" ? <T>Close</T> : <T>Not now</T>}
          </Button>
          <Button
            type="button"
            disabled={
              running ||
              !canSetUp ||
              (shown === null && eula.data === null) ||
              (askPermissionMode && permissionMode === null)
            }
            onClick={() => void accept()}
          >
            {running ? (
              <T>Setting up…</T>
            ) : shown?.phase === "failed" ? (
              <T>Try again</T>
            ) : (
              <T>Accept and set up</T>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
