import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useAgentdTasks } from "~/lib/agentdState";
import { newMessageId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useCloudWorkersLinked } from "./AgentdIndicator";
import { useAgentdState } from "./WorkerReadiness";
import { agentdTaskBelongsToProject } from "./backgroundTasks.logic";
import {
  OFFER_AFTER_MS,
  projectHasRunningWorker,
  showFirstTaskCard,
  workerOffer,
  workerOfferSignal,
} from "./agentdVisibility.logic";
import { openStartTaskDialog } from "./StartTaskDialog";
import { TASK_DRAFT_PROMPT, taskBranchProblem } from "./startTask.logic";

type Keys = Readonly<Record<string, true>>;
const keysAtom = (label: string) => Atom.make<Keys>({}).pipe(Atom.keepAlive, Atom.withLabel(label));
// Threads where the person sent while a turn ran, where an offer fired, and where it was put away.
const sentWhileRunning = keysAtom("agentd:offer-sent-while-running");
const fired = keysAtom("agentd:offer-fired");
const dismissed = keysAtom("agentd:offer-dismissed");
// The one thread per environment that shows "Try a worker" this run.
const firstTaskThread = Atom.make<Readonly<Record<string, string>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:first-task-thread"),
);
// Environments where "Try a worker" was hidden for now; it returns on the next run.
const firstTaskHidden = keysAtom("agentd:first-task-hidden");

function addKey(atom: typeof fired, key: string) {
  const current = appAtomRegistry.get(atom);
  if (current[key] !== true) appAtomRegistry.set(atom, { ...current, [key]: true });
}

/** The composer calls this on each send; a send during a running turn is an offer signal. */
export function noteThreadSend(threadRef: ScopedThreadRef | null, turnRunning: boolean) {
  if (threadRef !== null && turnRunning) addKey(sentWhileRunning, scopedThreadKey(threadRef));
}

interface NudgeProps {
  readonly threadRef: ScopedThreadRef | null;
  /** A Code thread: a project session, not a chat. */
  readonly codeThread: boolean;
  readonly turnRunning: boolean;
  readonly turnStartedAt: string | null;
  readonly workspaceRoot: string | null;
  readonly gitStatus: { readonly isRepo: boolean; readonly refName: string | null } | null;
}

/** Above a Code thread's composer: "Try a worker" until it is put away, then worker offers. */
export function AgentdThreadNudges(props: NudgeProps) {
  if (props.threadRef === null || !props.codeThread) return null;
  return <Nudges {...props} threadRef={props.threadRef} />;
}

function Nudges({
  threadRef,
  turnRunning,
  turnStartedAt,
  workspaceRoot,
  gitStatus,
}: NudgeProps & { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const key = scopedThreadKey(threadRef);
  const agentd = useAgentdState(environmentId);
  const agentdSetUp = agentd.state === "on" || agentd.state === "attention";
  const neverShowAgain = useClientSettings(
    (settings) => settings.agentdFirstTaskShown[environmentId] === true,
  );
  const hiddenThisSession = useAtomValue(firstTaskHidden)[environmentId] === true;
  const firstThread = useAtomValue(firstTaskThread)[environmentId];
  const hydrated = useClientSettingsHydrated();
  const firstEligible =
    hydrated &&
    showFirstTaskCard({
      neverShowAgain,
      hiddenThisSession,
      codeThread: true,
      agentdOn: agentd.state === "on",
      isRepo: gitStatus?.isRepo,
    });
  const claimThread = firstEligible && firstThread === undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- claims this thread as the environment's one "Try a worker" thread in the run-wide atom
  useEffect(() => {
    if (!claimThread) return;
    appAtomRegistry.set(firstTaskThread, {
      ...appAtomRegistry.get(firstTaskThread),
      [environmentId]: key,
    });
  }, [claimThread, environmentId, key]);

  if (firstEligible && firstThread === key) {
    return <FirstTaskCard threadRef={threadRef} />;
  }
  return (
    <WorkerOfferHost
      threadRef={threadRef}
      threadKey={key}
      agentdSetUp={agentdSetUp}
      turnRunning={turnRunning}
      turnStartedAt={turnStartedAt}
      workspaceRoot={workspaceRoot}
      gitStatus={gitStatus}
    />
  );
}

function FirstTaskCard({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const { environmentId } = threadRef;
  return (
    <section
      aria-label={gt("Try a worker")}
      className="mb-2 flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          <T>Try a worker</T>
        </p>
        <p className="text-muted-foreground text-xs">
          <T>Give a worker a task to run in the background while you keep working in this chat.</T>
        </p>
        <p className="text-muted-foreground text-xs">
          <T>For example, one worker can run tests while another updates the docs.</T>
        </p>
        <Button size="xs" variant="outline" onClick={() => openStartTaskDialog(threadRef)}>
          <T>Hand to a worker</T>
        </Button>
      </div>
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={gt("Dismiss")} />}>
          <XIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => addKey(firstTaskHidden, environmentId)}>
            <T>Hide for now</T>
          </MenuItem>
          <MenuItem
            onClick={() =>
              void updateClientSettings({
                agentdFirstTaskShown: {
                  ...getClientSettings().agentdFirstTaskShown,
                  [environmentId]: true,
                },
              })
            }
          >
            <T>Never show again</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </section>
  );
}

function WorkerOfferHost({
  threadRef,
  threadKey,
  agentdSetUp,
  turnRunning,
  turnStartedAt,
  workspaceRoot,
  gitStatus,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly agentdSetUp: boolean;
  readonly turnRunning: boolean;
  readonly turnStartedAt: string | null;
  readonly workspaceRoot: string | null;
  readonly gitStatus: NudgeProps["gitStatus"];
}) {
  const suggestWorkers = useClientSettings((settings) => settings.agentdSuggestWorkers);
  const sent = useAtomValue(sentWhileRunning)[threadKey] === true;
  const hasFired = useAtomValue(fired)[threadKey] === true;
  const isDismissed = useAtomValue(dismissed)[threadKey] === true;
  const startedAtMs = turnStartedAt === null ? null : Date.parse(turnStartedAt);
  const watching = suggestWorkers && agentdSetUp && !isDismissed && !hasFired && turnRunning;
  const validStart = startedAtMs !== null && Number.isFinite(startedAtMs) ? startedAtMs : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer for the five-minute signal of the running turn; nothing repaints meanwhile
  useEffect(() => {
    if (!watching) return;
    const signal = { running: true, startedAtMs: validStart, sentWhileRunning: sent };
    if (workerOfferSignal({ ...signal, nowMs: Date.now() })) {
      addKey(fired, threadKey);
      return;
    }
    if (validStart === null) return;
    const timer = setTimeout(
      () => addKey(fired, threadKey),
      Math.max(0, validStart + OFFER_AFTER_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [watching, sent, validStart, threadKey]);

  if (!suggestWorkers || isDismissed || !hasFired || !agentdSetUp) return null;
  return (
    <WorkerOfferCard
      threadRef={threadRef}
      threadKey={threadKey}
      turnRunning={turnRunning}
      workspaceRoot={workspaceRoot}
      gitStatus={gitStatus}
    />
  );
}

function WorkerOfferCard({
  threadRef,
  threadKey,
  turnRunning,
  workspaceRoot,
  gitStatus,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly turnRunning: boolean;
  readonly workspaceRoot: string | null;
  readonly gitStatus: NudgeProps["gitStatus"];
}) {
  const gt = useGT();
  const { environmentId, threadId } = threadRef;
  const thread = useQuietThreadShell(threadRef);
  const branch = gitStatus === null ? undefined : taskBranchProblem(gitStatus);
  const needsCloud = branch === "protected" || branch === "detached";
  const cloudLinked = useCloudWorkersLinked(needsCloud ? environmentId : null);
  const tasks = useAgentdTasks(environmentId).data ?? [];
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [drafting, setDrafting] = useState(false);
  const offer = workerOffer({
    suggestWorkers: true,
    dismissedInThread: false,
    signal: true,
    codeThread: true,
    agentdSetUp: true,
    branch,
    workerRunning: projectHasRunningWorker(tasks, (row) =>
      agentdTaskBelongsToProject(row, workspaceRoot, null),
    ),
    cloudLinked: cloudLinked === true,
  });
  if (offer === null || thread === null) return null;

  const draft = async () => {
    setDrafting(true);
    // Queued, so a running turn finishes first; the reply becomes the task card in the thread.
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: TASK_DRAFT_PROMPT,
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        dispatchMode: turnRunning ? "queue" : "start",
        createdAt: new Date().toISOString(),
      },
    });
    setDrafting(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not ask the session’s agent for a draft."),
        ...(cause instanceof Error ? { description: cause.message } : {}),
      });
      return;
    }
    addKey(dismissed, threadKey);
  };

  return (
    <section
      aria-label={gt("Hand this to a worker")}
      className="mb-2 space-y-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="space-y-0.5">
        <p className="font-medium">
          {offer === "cloud" ? <T>Hand this to Cloud Workers</T> : <T>Hand this to a worker</T>}
        </p>
        <p className="text-muted-foreground text-xs">
          {offer === "cloud" ? (
            <T>
              A local worker cannot start on this branch, so Cloud Workers would take the task while
              you keep working.
            </T>
          ) : offer === "local-or-cloud" ? (
            <T>
              A worker on this machine or Cloud Workers can take this task in the background while
              you keep working.
            </T>
          ) : (
            <T>A worker can take this task in the background while you keep working.</T>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={drafting} onClick={() => void draft()}>
          <T>Draft the task</T>
        </Button>
        <Button size="xs" variant="outline" onClick={() => addKey(dismissed, threadKey)}>
          <T>Not now</T>
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void updateClientSettings({ agentdSuggestWorkers: false })}
        >
          <T>Don&apos;t suggest again</T>
        </Button>
      </div>
    </section>
  );
}
