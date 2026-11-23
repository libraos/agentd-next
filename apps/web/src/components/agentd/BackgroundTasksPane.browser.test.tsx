import "~/index.css";

import {
  EMPTY_COMMAND_OUTPUT,
  applyCommandOutputFrame,
} from "@t3tools/client-runtime/state/command-output";
import { EnvironmentId, ThreadId, type AgentdTask, type AgentdTaskRow } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type * as AgentdState from "../../lib/agentdState";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { BackgroundTasksPane } from "./BackgroundTasksPane";

const bridge = vi.hoisted(() => ({
  useAgentdTasks: vi.fn<typeof AgentdState.useAgentdTasks>(),
  useAgentdTask: vi.fn<typeof AgentdState.useAgentdTask>(),
  useAgentdTaskOutput: vi.fn<typeof AgentdState.useAgentdTaskOutput>(),
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
      stopTask: { permissionAtom: () => canStop },
      cloudReview: (target: unknown) => target,
    },
    useAgentdCommands: () => ({ stopTask: bridge.stopTask }),
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
