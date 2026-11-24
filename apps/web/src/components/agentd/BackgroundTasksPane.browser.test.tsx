import "~/index.css";

import { RegistryProvider } from "@effect/atom-react";
import { recordServerClock } from "@t3tools/client-runtime/clock";
import {
  EMPTY_COMMAND_OUTPUT,
  applyCommandOutputFrame,
} from "@t3tools/client-runtime/state/command-output";
import {
  AgentdCommandError,
  EnvironmentId,
  ThreadId,
  type AgentdTask,
  type AgentdTaskRow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import type * as AgentdState from "../../lib/agentdState";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { BackgroundTasksPane as Pane } from "./BackgroundTasksPane";

function BackgroundTasksPane(props: Parameters<typeof Pane>[0]) {
  return (
    <RegistryProvider>
      <Pane {...props} />
    </RegistryProvider>
  );
}

const bridge = vi.hoisted(() => ({
  useAgentdTasks: vi.fn<typeof AgentdState.useAgentdTasks>(),
  useAgentdTask: vi.fn<typeof AgentdState.useAgentdTask>(),
  useAgentdTaskOutput: vi.fn<typeof AgentdState.useAgentdTaskOutput>(),
  sectionTaskRead: vi.fn<(id: string) => void>(),
  retryStart: vi.fn<ReturnType<typeof AgentdState.useAgentdCommands>["retryStart"]>(),
  stopTask: vi.fn<ReturnType<typeof AgentdState.useAgentdCommands>["stopTask"]>(),
  projects: vi.fn<() => ReadonlyArray<Record<string, unknown>>>(() => []),
  review: vi.fn<() => { data: null; error: string | null }>(() => ({ data: null, error: null })),
}));

vi.mock("../../lib/agentdState", async () => {
  const { Atom } = await import("effect/reactivity");
  const canStop = Atom.make(true);
  return {
    ...bridge,
    agentdEnvironment: {
      retryStart: { permissionAtom: () => canStop },
      tasks: ({ environmentId }: { environmentId: EnvironmentId }) =>
        Atom.make(AsyncResult.success(bridge.useAgentdTasks(environmentId).data ?? [])),
      task: ({ input: { id } }: { input: { id: string } }) => {
        bridge.sectionTaskRead(id);
        const { data } = bridge.useAgentdTask(id);
        return Atom.make(AsyncResult.success(data));
      },
      stopTask: { permissionAtom: () => canStop },
      cloudReview: (target: unknown) => target,
    },
    useAgentdCommands: () => ({ stopTask: bridge.stopTask, retryStart: bridge.retryStart }),
    useAgentdPermissionMode: () => ({ data: null, error: null }),
  };
});

vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useProjects: () => bridge.projects(),
}));

vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => bridge.review(),
}));

const threadRef = {
  environmentId: EnvironmentId.make("background-tasks-environment"),
  threadId: ThreadId.make("background-tasks-thread"),
};

const running: AgentdTaskRow = {
  id: "hof-123abc",
  title: "Build the widget",
  state: "claimed",
  workerState: null,
  workerRunning: true,
  workerTool: "codex",
  runsOn: "local",
  project: null,
  issue: null,
  started: null,
  branch: null,
  updated: "2026-11-18T09:00:00Z",
};

const finished: AgentdTaskRow = {
  ...running,
  id: "hof-456def",
  title: "Check the widget",
  state: "done",
  workerRunning: false,
  workerTool: "claude",
  runsOn: "cloud",
  cloudState: "completed",
  cloudUsd: 0.42,
  updated: "2026-11-18T09:01:30Z",
};

function taskDetails(row: AgentdTaskRow, extras: Partial<AgentdTask>): AgentdTask {
  return {
    id: row.id,
    title: row.title,
    goal: row.title,
    state: row.state,
    workerState: row.workerState,
    workerTool: row.workerTool,
    runsOn: row.runsOn,
    accept: [],
    check: null,
    verdict: null,
    costUsd: null,
    costEstimate: false,
    budget: null,
    budgetState: null,
    branch: null,
    note: null,
    project: null,
    hasLog: true,
    started: "2026-11-18T09:00:00Z",
    created: "2026-11-18T09:00:00Z",
    updated: row.updated,
    ...extras,
  };
}

function answer<Value>(data: Value) {
  return {
    data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  };
}

function setup() {
  vi.resetAllMocks();
  bridge.useAgentdTasks.mockReturnValue(answer([running, finished]));
  bridge.useAgentdTask.mockImplementation((id) =>
    answer(
      id === finished.id
        ? taskDetails(finished, {
            branch: "agentd/hof-456def",
            cloud: {
              state: "completed",
              modelAccess: "byok",
              workerUsd: 0.42,
              inferenceUsd: 0,
              totalUsd: 0.42,
            },
            verdict: {
              verdict: "verified",
              check: "passed: pnpm test",
              next: "Review the changes.",
              delivery: null,
            },
          })
        : taskDetails(running, { runsOn: "team" }),
    ),
  );
  bridge.stopTask.mockResolvedValue(AsyncResult.success({}));
  const output = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, {
    kind: "replace",
    text: `${"Compiling the widget\n".repeat(80)}First output line\n`,
    truncated: false,
    running: true,
  });
  bridge.useAgentdTaskOutput.mockReturnValue(answer(output));
  return output;
}

it("follows a running task's output and only stops the task after confirmation", async () => {
  const output = setup();
  const pane = () => (
    <>
      <BackgroundTasksPane threadRef={threadRef} />
      <ConfirmDialogHost />
    </>
  );
  await using screen = await render(pane());
  await expect.element(screen.getByRole("heading", { name: "Running 1" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Finished 1" })).toBeVisible();
  const runningRow = screen.getByRole("button", { name: /Build the widget/ });
  const finishedRow = screen.getByRole("button", { name: /Check the widget/ });
  await expect.element(runningRow.filter({ hasText: "Team node" })).toBeVisible();
  await expect
    .element(
      finishedRow.filter({
        hasText:
          /Cloud Worker.*Completed.*Your API key.*Worker cost: \$0\.42.*Inference: billed by your provider.*Total \(LibraOS\): \$0\.42.*agentd\/hof-456def.*1m 30s/,
      }),
    )
    .toBeVisible();
  await userEvent.click(finishedRow);
  await expect.element(screen.getByText("passed: pnpm test")).toBeVisible();
  await expect.element(screen.getByText("Review the changes.")).toBeVisible();

  await userEvent.click(runningRow);
  const region = screen.getByRole("region", { name: "Task output" });
  await expect.element(region.filter({ hasText: "First output line" })).toBeVisible();
  const scroller = region.element();
  expect(scroller.scrollTop).toBeGreaterThan(0);
  bridge.useAgentdTaskOutput.mockReturnValue(
    answer(
      applyCommandOutputFrame(output, {
        kind: "append",
        text: "New output line\n",
        truncated: false,
        running: true,
      }),
    ),
  );
  await screen.rerender(pane());
  await expect.element(region.filter({ hasText: "New output line" })).toBeVisible();
  expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThanOrEqual(1);

  const stopButton = screen.getByRole("button", { name: "Stop", exact: true });
  const dialog = page.getByRole("alertdialog", { name: "Stop this background task?" });
  await userEvent.click(stopButton);
  await expect.element(dialog).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(bridge.stopTask).not.toHaveBeenCalled();
  await expect.element(stopButton).toBeEnabled();
  await userEvent.click(stopButton);
  await userEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await expect.element(screen.getByRole("button", { name: "Stop requested" })).toBeDisabled();
  expect(bridge.stopTask).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { id: "hof-123abc", reason: "Stopped from LibraOS Next" },
  });
});

function setupQueuedTasks() {
  setup();
  const queued: AgentdTaskRow = {
    ...running,
    id: "hof-123def",
    title: "Plan the widget",
    state: "offered",
    workerRunning: false,
    workerTool: null,
  };
  const assigned: AgentdTaskRow = { ...queued, id: "hof-123fed", title: "Write the docs" };
  bridge.useAgentdTasks.mockReturnValue(answer([running, queued, assigned]));
  bridge.useAgentdTask.mockImplementation((id) =>
    answer(
      id === running.id
        ? taskDetails(running, { started: "2026-11-22T08:59:55Z", budget: "30m" })
        : id === assigned.id
          ? taskDetails(assigned, { workerTool: "codex", created: "2026-11-22T08:40:00Z" })
          : taskDetails(queued, { budget: "30m", startFolder: "/work/widget" }),
    ),
  );
  return queued;
}

it("shows queue age without spending time budget and keeps the running timer live", async () => {
  setupQueuedTasks();
  using _timers = fakeTimers({ now: new Date("2026-11-22T09:00:00Z") });
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  const runningRow = screen.getByRole("button", { name: /Build the widget/ });
  const queuedRow = screen.getByRole("button", { name: /Plan the widget/ });
  const assignedRow = screen.getByRole("button", { name: /Write the docs/ });
  await expect.element(screen.getByRole("heading", { name: "Running 1" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Queued 2" })).toBeVisible();
  await expect
    .element(queuedRow.getByText("Won't start on its own: no agent chosen", { exact: true }))
    .toBeVisible();
  await expect.element(queuedRow.getByText("Waiting a long time", { exact: true })).toBeVisible();
  await expect
    .element(assignedRow.getByText("Waiting for a Codex worker", { exact: true }))
    .toBeVisible();
  await expect
    .element(assignedRow.getByText("Queued for 20 minutes", { exact: true }))
    .toBeVisible();
  await expect
    .element(queuedRow.getByRole("progressbar", { name: "Budget used" }))
    .toHaveAttribute("aria-valuenow", "0");
  await expect
    .element(runningRow.getByRole("progressbar", { name: "Budget used" }))
    .toHaveAttribute("aria-valuenow", "0");
  await expect.element(runningRow.getByText("5s", { exact: true })).toBeVisible();
  const queuedText = queuedRow.element().textContent;
  await act(() => vi.advanceTimersByTime(2_000));
  await expect.element(runningRow.getByText("7s", { exact: true })).toBeVisible();
  expect(queuedRow.element().textContent).toBe(queuedText);
  expect(queuedText).toContain("Queued for 4 days");
});

it("shows stopped and waiting tasks without charging their queue time", async () => {
  setup();
  const stopped = { ...finished, state: "cancelled", runsOn: "local" as const, cloudState: null };
  const held = { ...running, state: "held", workerRunning: false };
  bridge.useAgentdTasks.mockReturnValue(answer([stopped, held]));
  bridge.useAgentdTask.mockImplementation((id) =>
    answer(taskDetails(id === stopped.id ? stopped : held, { started: null, budget: "30m" })),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  const stoppedRow = screen.getByRole("button", { name: /Check the widget/ });
  await expect.element(stoppedRow.getByText("Stopped", { exact: true })).toBeVisible();
  await expect.element(stoppedRow.getByText("Duration unavailable")).not.toBeInTheDocument();
  await expect.element(stoppedRow.getByRole("progressbar")).not.toBeInTheDocument();
  const heldRow = screen.getByRole("button", { name: /Build the widget/ });
  await expect.element(heldRow.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});

it("refreshes queued details even if the list row stays the same", async () => {
  const queued = setupQueuedTasks();
  const refresh = vi.fn<() => void>();
  bridge.useAgentdTask.mockImplementation((id) =>
    id === queued.id
      ? { ...answer(taskDetails(queued, { startFolder: "/work/widget" })), refresh }
      : answer(null),
  );
  using _timers = fakeTimers({ now: new Date("2026-11-22T09:00:59Z") });
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect.element(screen.getByRole("heading", { name: "Queued 2" })).toBeVisible();
  expect(refresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTime(1_000));
  expect(refresh).toHaveBeenCalledOnce();
});

it("shares one section subscription across panes in the same environment", async () => {
  setupQueuedTasks();
  const otherThread = { ...threadRef, threadId: ThreadId.make("other-background-thread") };
  const panes = () => (
    <RegistryProvider>
      <Pane threadRef={threadRef} />
      <Pane threadRef={otherThread} />
    </RegistryProvider>
  );
  await using screen = await render(panes());
  await expect.element(screen.getByRole("heading", { name: "Queued 2" }).last()).toBeVisible();
  expect(bridge.sectionTaskRead).toHaveBeenCalledTimes(3);
  bridge.sectionTaskRead.mockClear();
  await screen.rerender(panes());
  expect(bridge.sectionTaskRead).not.toHaveBeenCalled();
});

it("uses the environment clock for queue age", async () => {
  setupQueuedTasks();
  const now = Date.parse("2026-11-22T09:00:00Z");
  using _timers = fakeTimers({ now });
  recordServerClock(threadRef.environmentId, {
    serverTimeMs: now + 60 * 60_000,
    requestedAtMs: now,
    receivedAtMs: now,
  });
  try {
    await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
    await expect.element(screen.getByText("Queued for 1 hour", { exact: true })).toBeVisible();
  } finally {
    recordServerClock(threadRef.environmentId, {
      serverTimeMs: undefined,
      requestedAtMs: now,
      receivedAtMs: now,
    });
  }
});

it("offers Start with only for the unassigned task and keeps Stop available", async () => {
  const queued = setupQueuedTasks();
  bridge.retryStart.mockResolvedValue(
    AsyncResult.success({ id: queued.id, started: true, note: null }),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  const queuedItem = screen.getByRole("listitem").filter({ hasText: queued.title });
  await expect.element(queuedItem.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  const start = screen.getByRole("button", { name: "Start with…" });
  await expect.element(start).toBeVisible();
  expect(start.all()).toHaveLength(1);
  await userEvent.click(start);
  await userEvent.click(page.getByRole("menuitem", { name: "Codex", exact: true }));
  await expect.element(start).toBeEnabled();
  expect(bridge.retryStart).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { id: queued.id, action: "queued", worker: "codex" },
  });
});

it("moves blocked and budget-stopped offers into Waiting without a running clock", async () => {
  const queued = setupQueuedTasks();
  const blocked = { ...queued, id: "hof-132abc", title: "Blocked offer", workerRunning: true };
  const onHold = { ...queued, id: "hof-142abc", title: "Held offer", state: "held" };
  bridge.useAgentdTasks.mockReturnValue(answer([queued, blocked, onHold]));
  bridge.useAgentdTask.mockImplementation((id) =>
    answer(
      id === onHold.id
        ? taskDetails(onHold, {})
        : id === blocked.id
          ? taskDetails(blocked, { workerState: "blocked" })
          : taskDetails(queued, { budgetState: "budget_exceeded", startFolder: "/work/widget" }),
    ),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect.element(screen.getByRole("heading", { name: "Running 0" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Waiting 3" })).toBeVisible();
  expect(screen.getByRole("heading", { name: /Queued/ }).all()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Start with…" }).all()).toHaveLength(0);
  await expect
    .element(screen.getByRole("button", { name: /Blocked offer Waiting for a person/ }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Held offer On hold/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Plan the widget Waiting for a person/ }))
    .toBeVisible();
  expect(screen.getByText(/^[0-9]+[hms]/).all()).toHaveLength(0);
});

it("shows Core's park reason in Waiting and explicitly force-starts the task", async () => {
  const parked = setupQueuedTasks();
  const reason = "4 worker rounds, the limit";
  bridge.useAgentdTasks.mockReturnValue(answer([parked]));
  bridge.useAgentdTask.mockReturnValue(
    answer(
      taskDetails(parked, { parked: reason, workerTool: "codex", startFolder: "/work/widget" }),
    ),
  );
  bridge.retryStart.mockResolvedValue(
    AsyncResult.success({ id: parked.id, started: true, note: null }),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect.element(screen.getByRole("heading", { name: "Waiting 1" })).toBeVisible();
  await expect.element(screen.getByText("Waiting for a person", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(reason, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Start anyway" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Codex", exact: true }));
  expect(bridge.retryStart).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { id: parked.id, action: "parked", worker: "codex" },
  });
});

it.each([
  ["budget: worker spent its budget", "unpark", "Release this task in a LibraOS Core terminal."],
  [
    "repository command: setup requires approval",
    "approval",
    "Check the LibraOS Core Inbox for a command approval.",
  ],
] as const)("shows the required next step for %s", async (reason, parkAction, nextStep) => {
  const parked = setupQueuedTasks();
  bridge.useAgentdTasks.mockReturnValue(answer([parked]));
  bridge.useAgentdTask.mockReturnValue(
    answer(taskDetails(parked, { parked: reason, parkAction, startFolder: "/work/widget" })),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect.element(screen.getByRole("heading", { name: "Waiting 1" })).toBeVisible();
  await expect.element(screen.getByText(reason, { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Start anyway" }).all()).toHaveLength(0);
  await expect.element(screen.getByText(nextStep, { exact: true })).toBeVisible();
  if (parkAction === "unpark") {
    await expect
      .element(screen.getByText(`libraos-core handoff unpark ${parked.id}`, { exact: true }))
      .toBeVisible();
  }
});

it("shows the wait since requeue instead of the original offer", async () => {
  const requeued = setupQueuedTasks();
  bridge.useAgentdTasks.mockReturnValue(answer([requeued]));
  bridge.useAgentdTask.mockReturnValue(
    answer(
      taskDetails(requeued, {
        workerTool: "codex",
        created: "2026-11-18T09:00:00Z",
        queuedSince: "2026-11-22T08:59:00Z",
      }),
    ),
  );
  using _timers = fakeTimers({ now: new Date("2026-11-22T09:00:00Z") });
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect.element(screen.getByText("Queued for 1 minute", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Waiting a long time")).not.toBeInTheDocument();
});

it("explains targeted and remote offers without offering a local start", async () => {
  const queued = setupQueuedTasks();
  const addressed = { ...queued, id: "hof-123123", title: "Addressed offer" };
  const remote = { ...queued, id: "hof-323123", title: "Remote offer" };
  const blocked = { ...queued, id: "hof-423123", title: "Blocked offer" };
  const queueBlock = "spec before code: missing spec";
  bridge.useAgentdTasks.mockReturnValue(answer([addressed, remote, blocked]));
  bridge.useAgentdTask.mockImplementation((id) =>
    answer(
      id === addressed.id
        ? taskDetails(addressed, {
            queuePickup: "recipient",
            queueBlock: "project concurrency limit: libraos/next",
            startFolder: "/work/widget",
          })
        : id === remote.id
          ? taskDetails(remote, { queuePickup: "remote", startFolder: "/work/widget" })
          : taskDetails(blocked, { queueBlock, startFolder: "/work/widget" }),
    ),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await expect
    .element(screen.getByText("Waiting for the recipient to pick up this task"))
    .toBeVisible();
  await expect.element(screen.getByText("Waiting for a remote worker")).toBeVisible();
  await expect.element(screen.getByText("Needs a specification: missing spec")).toBeVisible();
  expect(screen.getByRole("button", { name: "Start with…" }).all()).toHaveLength(0);
});

it("shows the selected checkout and retries Claude only after folder consent", async () => {
  const queued = setupQueuedTasks();
  bridge.retryStart
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new AgentdCommandError({
            message: "Untrusted",
            notSetUp: false,
            untrustedFolder: "/work/main-widget",
          }),
        ),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success({ id: queued.id, started: true, note: null }));
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Start with…" }));
  await expect.element(page.getByText("Working directory: /work/widget")).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Claude Code" }));
  await expect
    .element(page.getByRole("alertdialog", { name: "Let Claude Code work in /work/main-widget?" }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Trust folder" }));
  await expect.element(screen.getByRole("button", { name: "Start with…" })).toBeEnabled();
  expect(bridge.retryStart.mock.calls.map(([call]) => call.input)).toEqual([
    { id: queued.id, action: "queued", worker: "claude" },
    { id: queued.id, action: "queued", worker: "claude", trustedFolder: "/work/main-widget" },
  ]);
});

it("offers the same folder conflict choices for a queued start", async () => {
  const queued = setupQueuedTasks();
  const blocking = { id: "hof-889abc", state: "offered", goal: "Another task", running: false };
  bridge.retryStart
    .mockResolvedValueOnce(
      AsyncResult.success({ id: queued.id, started: false, note: "Folder busy", blocking }),
    )
    .mockResolvedValueOnce(AsyncResult.success({ id: queued.id, started: true, note: null }));
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Start with…" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Codex", exact: true }));
  const dialog = page.getByRole("alertdialog", { name: "Couldn't start task" });
  await expect.element(dialog.getByRole("button", { name: "Release it" })).toBeEnabled();
  await userEvent.click(dialog.getByRole("button", { name: "Start anyway" }));
  expect(bridge.retryStart).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { id: queued.id, action: "force", worker: "codex", blocking: blocking.id, queued: true },
  });
  await expect.element(dialog).not.toBeInTheDocument();
});

it.each([
  ["no-longer-queued", "This task is no longer waiting for an agent."],
  ["has-recipient", "This task was sent to a specific session."],
  ["no-checkout", "No local checkout is available for this task."],
] as const)("presents the full refusal for %s and allows dismissal", async (refusal, message) => {
  setupQueuedTasks();
  bridge.retryStart.mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new AgentdCommandError({
          message: "Core refusal",
          notSetUp: false,
          queuedStartRefusal: refusal,
        }),
      ),
    ),
  );
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  const start = screen.getByRole("button", { name: "Start with…" });
  await userEvent.click(start);
  await userEvent.click(page.getByRole("menuitem", { name: "Codex", exact: true }));
  const dialog = page.getByRole("alertdialog", { name: "Couldn't start task" });
  await expect.element(dialog.getByText(message)).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Close" }));
  await expect.element(start).toBeEnabled();
});

it("offers Review changes from a git checkout of the task's repository and opens its pull request", async () => {
  setup();
  bridge.useAgentdTasks.mockReturnValue(answer([finished]));
  bridge.useAgentdTask.mockReturnValue(
    answer(
      taskDetails(finished, {
        branch: "agentd/hof-456def",
        project: "acme/app",
        cloud: {
          state: "completed",
          modelAccess: "libraos",
          workerUsd: 0.42,
          inferenceUsd: 0,
          totalUsd: 0.42,
          pullRequest: { url: "https://github.com/acme/app/pull/7", number: 7 },
        },
      }),
    ),
  );
  const folder = {
    environmentId: threadRef.environmentId,
    workspaceRoot: "/home/user/notes",
    repositoryIdentity: null,
  };
  const checkout = {
    environmentId: threadRef.environmentId,
    workspaceRoot: "/home/user/app",
    repositoryIdentity: {
      canonicalKey: "github.com/upstream/app",
      locator: { source: "git-remote", remoteName: "upstream", remoteUrl: "x" },
      origin: { canonicalKey: "github.com/Acme/App" },
    },
  };
  bridge.projects.mockReturnValue([folder]);
  bridge.review.mockReturnValue({ data: null, error: "The task’s branch is no longer on GitHub." });

  {
    // A folder workspace without git offers no review; the pull request link needs no checkout.
    await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
    const pullRequest = screen.getByRole("link", { name: "Open pull request #7" });
    await expect.element(pullRequest).toHaveAttribute("href", "https://github.com/acme/app/pull/7");
    expect(screen.getByRole("button", { name: "Review changes" }).query()).toBeNull();
  }

  bridge.projects.mockReturnValue([folder, checkout]);
  await using screen = await render(<BackgroundTasksPane threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await expect.element(dialog.getByText(/agentd\/hof-456def.*\/home\/user\/app/)).toBeVisible();
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("The task’s branch is no longer on GitHub.");
});
