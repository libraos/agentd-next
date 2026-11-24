import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, Var } from "gt-react";

import { useAgentdTasks } from "../../lib/agentdState";
import { useQuietThreadProjection } from "../../state/entities";
import { deriveThreadPendingBackgroundTasks } from "../ChatView.logic";
import { useCommandOutputStreaming } from "../chat/CommandOutputPanel";
import { AgentdBackgroundTaskRow } from "./AgentdBackgroundTaskRow";
import { isFinishedAgentdTask, isQueuedAgentdTask } from "./backgroundTasks.logic";
import { SessionBackgroundTaskRow } from "./SessionBackgroundTaskRow";

export function BackgroundTasksPane({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const { data, error, failure, isPending } = useAgentdTasks(environmentId);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const sessionTasks = deriveThreadPendingBackgroundTasks(projection);
  const streamsOutput = useCommandOutputStreaming(environmentId);
  const rows = data ?? [];
  const running = rows.filter(
    (row) => !isFinishedAgentdTask(row.state) && !isQueuedAgentdTask(row),
  );
  const queued = rows.filter(isQueuedAgentdTask);
  const finished = rows.filter((row) => isFinishedAgentdTask(row.state));

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
                    finished={false}
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
                  finished={false}
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
                    finished
                  />
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {failure?._tag === "AgentdNotFoundError" && failure.bundled ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Next carries its own LibraOS Core, and it could not be run. Reinstall LibraOS
              Next to restore it.
            </T>
          </p>
        ) : failure?._tag === "AgentdNotFoundError" ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Core was not found in this environment. Follow the{" "}
              <a
                className="text-foreground underline"
                href="https://github.com/libraos/libraos-core#installation"
                target="_blank"
                rel="noreferrer"
              >
                LibraOS Core installation guide
              </a>{" "}
              and make sure the binary is on the server&apos;s path.
            </T>
          </p>
        ) : failure?._tag === "AgentdCommandError" && failure.notSetUp ? (
          <p className="text-muted-foreground" role="status">
            <T>
              LibraOS Core is installed but not set up. Run <code>libraos-core init</code> on the
              server to set it up.
            </T>
          </p>
        ) : error ? (
          <p className="wrap-anywhere text-destructive" role="alert">
            <T>
              Couldn&apos;t load LibraOS Core tasks: <Var>{error}</Var>
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
                  <T>LibraOS Core tasks are unavailable in this environment.</T>
                </p>
              </>
            )}
          </div>
        ) : data.length === 0 ? (
          <p className="text-muted-foreground" role="status">
            {sessionTasks.length === 0 ? <T>No background tasks</T> : <T>No LibraOS Core tasks.</T>}
          </p>
        ) : null}
      </div>
    </div>
  );
}
