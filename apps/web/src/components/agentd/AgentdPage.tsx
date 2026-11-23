import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AgentdHandoffId,
  AgentdNotFoundError,
  AuthOrchestrationReadScope,
  type AgentdTaskRow,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import {
  useAgentdApprovals,
  useAgentdCloudAccount,
  useAgentdInbox,
  useAgentdPeople,
  useAgentdStatus,
  useAgentdTask,
  useAgentdTasks,
} from "../../lib/agentdState";
import { useVisibleThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { openBackgroundTasks } from "../chat/useRightPanelActions";
import { getAppModalReturnThreadTarget } from "../sidebar/mainAppLocation";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { AgentdNeedsYou, AgentdRead, AgentdSection, AgentdStatusDetails } from "./AgentdPageReads";
import { TaskWaiting } from "./WorkerPermissionMode";
import { AgentdPageCloud } from "./AgentdPageCloud";
import { AgentdPagePlugins } from "./AgentdPagePlugins";
import { AgentdPageWorkers } from "./AgentdPageWorkers";
import { openAgentdSetupDialog, useCanSetUpAgentd } from "./AgentdSetupDialog";
import { AgentdTeamNodeSwitch } from "./AgentdTeamNodeSwitch";

const isHandoffId = Schema.is(AgentdHandoffId);
const isAgentdNotFoundError = Schema.is(AgentdNotFoundError);

export function AgentdPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useAgentdStatus(environmentId);
  const canSetUp = useCanSetUpAgentd(environmentId);
  const notFound = isAgentdNotFoundError(status.failure) ? status.failure : null;
  const activeEnvironmentId = status.data?.setUp && notFound === null ? environmentId : null;
  const tasks = useAgentdTasks(activeEnvironmentId);
  const people = useAgentdPeople(activeEnvironmentId, true);
  const approvals = useAgentdApprovals(activeEnvironmentId);
  const inbox = useAgentdInbox(activeEnvironmentId);
  const threads = useVisibleThreadShells(activeEnvironmentId !== null);
  const [selectedTask, setSelectedTask] = useState<{
    id: AgentdHandoffId;
    environmentId: NonNullable<typeof environmentId>;
  } | null>(null);
  const task = useAgentdTask(selectedTask?.id ?? null, selectedTask?.environmentId ?? null);
  const cloudAccount = useAgentdCloudAccount(activeEnvironmentId);

  const refresh = () => {
    status.refresh();
    tasks.refresh();
    people.refresh();
    approvals.refresh();
    inbox.refresh();
    task.refresh();
    cloudAccount.refresh();
  };

  const openTask = (row: AgentdTaskRow) => {
    if (activeEnvironmentId === null || !isHandoffId(row.id)) return;
    const previous = getAppModalReturnThreadTarget();
    const thread = threads.find(
      (candidate) =>
        candidate.environmentId === activeEnvironmentId && candidate.archivedAt === null,
    );
    const threadRef =
      previous?.kind === "server" && previous.threadRef.environmentId === activeEnvironmentId
        ? previous.threadRef
        : thread
          ? scopeThreadRef(thread.environmentId, thread.id)
          : null;
    if (threadRef === null) {
      setSelectedTask({ id: row.id, environmentId: activeEnvironmentId });
      return;
    }
    openBackgroundTasks(threadRef);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      hash: `agentd-task-${row.id}`,
      replace: true,
    });
  };

  const openTaskId = (id: string) => {
    const row = tasks.data?.find((candidate) => candidate.id === id);
    if (row) openTask(row);
    else if (activeEnvironmentId !== null && isHandoffId(id)) {
      setSelectedTask({ id, environmentId: activeEnvironmentId });
    }
  };

  return (
    <AppRouteModal label={gt("LibraOS Core")}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 sm:px-7">
        <h1 className="text-lg font-semibold">
          <T>LibraOS Core</T>
        </h1>
        <div className="flex items-center gap-2">
          {canRead ? (
            <Button size="sm" variant="outline" onClick={refresh}>
              <RefreshCwIcon />
              <T>Refresh</T>
            </Button>
          ) : null}
          <AppRouteModalClose />
        </div>
      </header>
      <div className="min-h-0 grow overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto grid max-w-4xl gap-4 p-5 sm:p-7">
          {selectedTask !== null ? (
            <AgentdSection id="agentd-task" title={<T>Background task</T>}>
              <Button size="sm" variant="outline" onClick={() => setSelectedTask(null)}>
                <T>Back to LibraOS Core</T>
              </Button>
              <AgentdRead query={task}>
                {(data) => (
                  <div className="space-y-2 text-sm">
                    <p className="font-medium">{data.title || data.id}</p>
                    {data.goal && data.goal !== data.title ? (
                      <p className="whitespace-pre-wrap break-words">{data.goal}</p>
                    ) : null}
                    <p className="text-muted-foreground">{data.workerState ?? data.state}</p>
                    {data.workerState === "blocked" ? <TaskWaiting task={data} /> : null}
                    {data.note ? (
                      <p className="whitespace-pre-wrap break-words">{data.note}</p>
                    ) : null}
                    <p className="text-muted-foreground">
                      <T>Open a session to view this task in Background tasks.</T>
                    </p>
                  </div>
                )}
              </AgentdRead>
            </AgentdSection>
          ) : (
            <>
              <AgentdSection id="agentd-status" title={<T>Status</T>}>
                {environmentId === null ? (
                  <p className="text-sm text-muted-foreground">
                    <T>No environment is connected.</T>
                  </p>
                ) : !canRead ? (
                  <p className="text-sm text-muted-foreground">
                    <T>LibraOS Core status requires read access to this environment.</T>
                  </p>
                ) : notFound !== null ? (
                  <Alert variant="warning">
                    <AlertTitle>
                      <T>LibraOS Core not found</T>
                    </AlertTitle>
                    <AlertDescription>
                      <p>{notFound.message}</p>
                      {notFound.bundled ? (
                        <p>
                          <T>
                            LibraOS Next carries its own LibraOS Core, and it could not be run.
                            Reinstall LibraOS Next to restore it.
                          </T>
                        </p>
                      ) : (
                        <p>
                          <T>
                            Follow the{" "}
                            <a
                              className="underline"
                              href="https://github.com/libraos/agentd#installation"
                              target="_blank"
                              rel="noreferrer"
                            >
                              LibraOS Core install guide
                            </a>
                            , then make sure the binary is on <code>PATH</code> on this environment.
                          </T>
                        </p>
                      )}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <AgentdRead query={status}>
                    {(data) => (
                      <AgentdStatusDetails
                        status={data}
                        environmentId={environmentId}
                        onRepaired={status.refresh}
                        onSetUp={
                          canSetUp && environmentId !== null
                            ? () => openAgentdSetupDialog(environmentId)
                            : undefined
                        }
                        team={
                          activeEnvironmentId !== null ? (
                            <AgentdTeamNodeSwitch
                              environmentId={activeEnvironmentId}
                              openTask={openTaskId}
                            />
                          ) : null
                        }
                      />
                    )}
                  </AgentdRead>
                )}
              </AgentdSection>
              {environmentId !== null && canRead ? (
                <AgentdSection id="agentd-plugins" title={<T>Plugins</T>}>
                  <AgentdPagePlugins environmentId={environmentId} />
                </AgentdSection>
              ) : null}
              {activeEnvironmentId !== null ? (
                <>
                  <AgentdSection id="agentd-needs-you" title={<T>Needs you</T>}>
                    <AgentdNeedsYou approvals={approvals} inbox={inbox} />
                  </AgentdSection>
                  <AgentdSection id="agentd-workers" title={<T>Workers</T>}>
                    <AgentdPageWorkers tasks={tasks} people={people} open={openTask} />
                  </AgentdSection>
                  <AgentdSection id="agentd-cloud" title={<T>Cloud Workers</T>}>
                    <AgentdPageCloud environmentId={activeEnvironmentId} />
                  </AgentdSection>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </AppRouteModal>
  );
}
