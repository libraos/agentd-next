import { useAtomValue } from "@effect/atom-react";
import type {
  AgentdApproval,
  AgentdTaskRow,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { T, Var } from "gt-react";

import { agentdEnvironment, useAgentdTasks } from "../../lib/agentdState";
import { useQuietThreadProjection } from "../../state/entities";
import { deriveThreadPendingBackgroundTasks } from "../ChatView.logic";
import { useCommandOutputStreaming } from "../chat/CommandOutputPanel";
import { AgentdBackgroundTaskRow } from "./AgentdBackgroundTaskRow";
import {
  type AgentdTaskSection,
  agentdTaskSection,
  isFinishedAgentdTask,
} from "./backgroundTasks.logic";
import { SessionBackgroundTaskRow } from "./SessionBackgroundTaskRow";

const EMPTY_ROWS: readonly AgentdTaskRow[] = [];
const EMPTY_APPROVALS: readonly AgentdApproval[] = [];

const taskSections = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const rows = AsyncResult.getOrElse(
      get(agentdEnvironment.tasks({ environmentId, input: {} })),
      () => EMPTY_ROWS,
    );
    const approvals = AsyncResult.getOrElse(
      get(agentdEnvironment.approvals({ environmentId, input: {} })),
      () => EMPTY_APPROVALS,
    );
    const sections: Record<AgentdTaskSection, AgentdTaskRow[]> = {
      running: [],
      queued: [],
      waiting: [],
      finished: [],
    };
    for (const row of rows) {
      if (isFinishedAgentdTask(row.state)) {
        sections.finished.push(row);
        continue;
      }
      const result = get(agentdEnvironment.task({ environmentId, input: { id: row.id } }));
      const details = AsyncResult.getOrElse(result, () => null);
      const task = details?.state === row.state ? details : null;
      const status = {
        ...row,
        runsOn: task?.runsOn ?? row.runsOn,
        workerState: row.workerState ?? task?.workerState ?? null,
      };
      sections[agentdTaskSection(status, task, approvals)].push(row);
    }
    return sections;
  }),
);

export function BackgroundTasksPane({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const { data, error, failure, isPending } = useAgentdTasks(environmentId);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const sessionTasks = deriveThreadPendingBackgroundTasks(projection);
  const streamsOutput = useCommandOutputStreaming(environmentId);
  const rows = data ?? EMPTY_ROWS;
  const { running, queued, waiting, finished } = useAtomValue(taskSections(environmentId));

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain p-3 text-sm">
      <div className="space-y-5">
        {(data !== null && data.length > 0) || sessionTasks.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">
              <T>
                Running <Var>{running.length}</Var>
              </T>
              {sessionTasks.length > 0 ? (
                <span className="ms-2">
                  <T>
                    + <Var>{sessionTasks.length}</Var> from this session
                  </T>
                </span>
              ) : null}
            </h2>
            {running.length === 0 && sessionTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No running tasks.</T>
              </p>
            ) : (
              <ul className="space-y-1.5">
                {sessionTasks.map((task) => (
                  <SessionBackgroundTaskRow
                    key={task.taskId}
                    task={task}
                    threadRef={threadRef}
                    turnItems={projection?.turnItems ?? []}
                    streamsOutput={streamsOutput}
                    agentdRows={rows}
                  />
                ))}
                {running.map((row) => (
                  <AgentdBackgroundTaskRow
                    key={row.id}
                    row={row}
                    environmentId={environmentId}
                    section="running"
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {queued.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">
              <T>
                Queued <Var>{queued.length}</Var>
              </T>
            </h2>
            <ul className="space-y-1.5">
              {queued.map((row) => (
                <AgentdBackgroundTaskRow
                  key={row.id}
                  row={row}
                  environmentId={environmentId}
                  section="queued"
                />
              ))}
            </ul>
          </section>
        ) : null}
        {waiting.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">
              <T>
                Waiting <Var>{waiting.length}</Var>
              </T>
            </h2>
            <ul className="space-y-1.5">
              {waiting.map((row) => (
                <AgentdBackgroundTaskRow
                  key={row.id}
                  row={row}
                  environmentId={environmentId}
                  section="waiting"
                />
              ))}
            </ul>
          </section>
        ) : null}
        {data !== null && data.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">
              <T>
                Finished <Var>{finished.length}</Var>
              </T>
            </h2>
            {finished.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No finished tasks.</T>
              </p>
            ) : (
              <ul className="space-y-1.5">
                {finished.map((row) => (
                  <AgentdBackgroundTaskRow
                    key={row.id}
                    row={row}
                    environmentId={environmentId}
                    section="finished"
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {failure?._tag === "AgentdNotFoundError" && failure.bundled ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Next carries its own LibraOS Engine, and it could not be run. Reinstall
              LibraOS Next to restore it.
            </T>
          </p>
        ) : failure?._tag === "AgentdNotFoundError" ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Engine was not found in this environment. Follow the{" "}
              <a
                className="text-foreground underline"
                href="https://github.com/libraos/engine#installation"
                target="_blank"
                rel="noreferrer"
              >
                LibraOS Engine installation guide
              </a>{" "}
              and make sure the binary is on the server&apos;s path.
            </T>
          </p>
        ) : failure?._tag === "AgentdCommandError" && failure.notSetUp ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Engine is installed but not set up. Run <code>libraos-core init</code> on the
              server to set it up.
            </T>
          </p>
        ) : error ? (
          <p className="wrap-anywhere text-destructive" role="alert">
            <T>
              Couldn&apos;t load LibraOS Engine tasks: <Var>{error}</Var>
            </T>
          </p>
        ) : data === null ? (
          <div className="space-y-1 text-muted-foreground" role="status">
            {isPending ? (
              <p>
                <T>Loading background tasks…</T>
              </p>
            ) : (
              <>
                {sessionTasks.length === 0 ? (
                  <p className="font-medium">
                    <T>No background tasks</T>
                  </p>
                ) : null}
                <p>
                  <T>LibraOS Engine tasks are unavailable in this environment.</T>
                </p>
              </>
            )}
          </div>
        ) : data.length === 0 ? (
          <p className="text-muted-foreground" role="status">
            {sessionTasks.length === 0 ? (
              <T>No background tasks</T>
            ) : (
              <T>No LibraOS Engine tasks.</T>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
