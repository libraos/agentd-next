import "~/index.css";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AgentdCommandError,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudPlanState,
  type AgentdCloudSetup,
  type AgentdStartTaskResult,
  type AgentdTaskDefaults,
  type AgentdTaskOther,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ThreadId,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { hostRightPanel, selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { makeThreadFixture } from "~/test-fixtures";
import { render, stubGlobal } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { AgentdPageCloud } from "./AgentdPageCloud";
import { CloudWorkersSetup } from "./CloudWorkersSetup";
import { openStartTaskDialog, StartTaskDialogHost } from "./StartTaskDialog";
import { EMPTY_TASK_FIELDS } from "./startTask.logic";
import { TaskDraftCard } from "./TaskDraftCard";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  configure: vi.fn(),
  cloudRefresh: vi.fn(),
  refresh: vi.fn(),
  branch: "feature/export",
  cloud: null as AgentdCloudSetup | null,
  others: [] as AgentdTaskOther[],
  defaults: { estimate: null, check: null } as AgentdTaskDefaults,
  gateway: false,
  worker: "opencode" as string | null,
  dollarBudgets: null as boolean | null,
  primary: null as EnvironmentId | null,
  os: "unknown" as ExecutionEnvironmentPlatformOs,
  cloudError: null as Error | null,
  keyFiles: {} as Record<string, AgentdCloudKeyFileCheck>,
  // Paths this connection may not check: it lacks filesystem read.
  keyFilesDenied: new Set<string>(),
  fixKeyFile: vi.fn(),
  tasks: vi.fn(),
  // The synced task list, as its subscription last answered.
  rows: [] as Array<{ id: string; cloudState: string | null }>,
  rowListeners: new Set<() => void>(),
  // The thread is a draft not yet on the server.
  draft: false,
}));

vi.mock("~/lib/agentdState", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useReducer, useSyncExternalStore } = await import("react");
  const allowed = Atom.make(true);
  return {
    agentdEnvironment: {
      startTask: { permissionAtom: () => allowed },
      cloudConfigure: { permissionAtom: () => allowed, label: "cloud-configure" },
      cloudKeyFileFix: { permissionAtom: () => allowed },
    },
    useAgentdStatus: () => ({
      data: { defaultWorker: state.worker, dollarBudgets: state.dollarBudgets },
    }),
    useAgentdTaskDefaults: () => ({ data: state.defaults }),
    useAgentdCloudSetup: (cwd: string | null) => ({
      data: cwd && state.cloudError === null ? state.cloud : null,
      error: state.cloudError,
      refresh: state.cloudRefresh,
    }),
    useAgentdCloudKeyFile: (path: string | null) => {
      // A refresh reads the file's state again, as the real query does.
      const [, refresh] = useReducer((n: number) => n + 1, 0);
      const denied = path !== null && state.keyFilesDenied.has(path);
      return {
        data: path === null || denied ? null : (state.keyFiles[path] ?? null),
        error: denied ? "This connection requires filesystem:read." : null,
        failure: denied
          ? new EnvironmentAuthorizationError({
              message: "This connection requires filesystem:read.",
              requiredScope: "filesystem:read",
            })
          : null,
        refresh,
      };
    },
    useAgentdCommands: () => ({ cloudKeyFileFix: state.fixKeyFile }),
    useAgentdCloudAccount: () => ({
      data: state.cloud,
      error: null,
      refresh: state.cloudRefresh,
    }),
    useAgentdTaskOthers: () => ({ data: state.others, isPending: false, isSuccess: true }),
    useAgentdTasks: (environmentId: EnvironmentId) => {
      state.tasks(environmentId);
      const data = useSyncExternalStore(
        (listener) => {
          state.rowListeners.add(listener);
          return () => state.rowListeners.delete(listener);
        },
        () => state.rows,
      );
      return { data };
    },
  };
});
vi.mock("~/lib/libraosGatewayState", () => ({
  useLibraosGatewayConnected: () => state.gateway,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironment: () => ({
    serverConfig: { environment: { platform: { os: state.os } } },
  }),
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => (state.draft ? null : thread),
  useProject: (ref: unknown) => (ref ? { workspaceRoot: "/repo" } : null),
  useThreadProjection: () => null,
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { refreshLocalStatusForPicker: state.refresh, status: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: { isRepo: true, refName: state.branch }, error: null }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.refresh
      ? state.refresh
      : (command as { label?: string }).label === "cloud-configure"
        ? state.configure
        : state.start,
}));

const thread = makeThreadFixture({ worktreePath: "/repo/worktrees/export" });
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const parentRef = scopeThreadRef(thread.environmentId, ThreadId.make("parent-thread"));

function setup(
  branch: string,
  open: boolean | typeof drafted = true,
  settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {},
) {
  // Remembered key paths are read back from storage: an earlier test's must not leak in.
  localStorage.clear();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  state.branch = branch;
  state.cloud = null;
  state.others = [];
  state.defaults = { estimate: null, check: null };
  state.gateway = false;
  state.primary = null;
  state.os = "unknown";
  state.worker = "opencode";
  state.cloudError = null;
  state.keyFiles = {};
  state.keyFilesDenied = new Set();
  state.fixKeyFile.mockReset();
  state.tasks.mockReset();
  state.rows = [];
  state.rowListeners.clear();
  state.dollarBudgets = null;
  state.draft = false;
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
  state.start.mockReset();
  state.configure.mockReset();
  state.cloudRefresh.mockReset();
  state.refresh
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ isRepo: true, refName: branch }));
  useRightPanelStore.setState({ byThreadKey: {} });
  if (open === true) openStartTaskDialog(threadRef);
  else if (open !== false) openStartTaskDialog(threadRef, open);
}

const drafted = {
  ...EMPTY_TASK_FIELDS,
  goal: "Fix export",
  accept: "Keeps the row order",
  check: "pnpm test",
  size: "small" as const,
};
const estimate = { type: "small" as const, low: 1.78, median: 3.11, high: 4.98, jobs: 146 };

function renderDialog() {
  return render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <StartTaskDialogHost />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
}

async function fillTask() {
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await userEvent.fill(page.getByLabelText("Check command"), "pnpm test");
  await userEvent.fill(page.getByLabelText("Budget"), "30m,$2");
}

it("shows what is missing, displays a refusal in full, and opens the tasks pane on success", async () => {
  setup("feature/export");
  state.others = [{ person: "Bob", work: "acme/app#42", activity: null, paths: ["src/export.ts"] }];
  const refusal = "Task refused: worker is not connected.\n  Run setup and try again.";
  state.start
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new AgentdCommandError({ message: refusal, notSetUp: false })),
      ),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        id: "hof-123abc",
        started: true,
        note: null,
      } satisfies AgentdStartTaskResult),
    );
  await using _screen = await renderDialog();
  using _host = { [Symbol.dispose]: hostRightPanel(threadRef, parentRef) };
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(start).toBeDisabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Run in the cloud" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Enter a goal.")).toBeVisible();
  await expect.element(page.getByText("Enter a check command.")).toBeVisible();
  await expect.element(page.getByLabelText("Budget")).toHaveValue("60m,$5");
  await expect
    .element(page.getByRole("combobox", { name: "Worker" }))
    .toHaveTextContent("opencode");
  await expect
    .element(page.getByLabelText("Working directory"))
    .toHaveValue("/repo/worktrees/export");

  await fillTask();
  const notice = page.getByRole("status").filter({ hasText: "Others are working here" });
  await expect.element(notice.getByText("Bob: acme/app#42")).toBeVisible();
  await expect.element(notice.getByText("src/export.ts")).toBeVisible();
  await start.click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(page.getByRole("alert").element().textContent).toBe(refusal);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, parentRef)).toBeNull();

  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, parentRef)).toBe(
    "background-tasks",
  );
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: "pnpm test",
      worker: "opencode",
      budget: "30m,$2",
      issue: null,
    },
  });
});

it("asks before a Claude worker runs in an untrusted folder, and starts only on Trust", async () => {
  setup("feature/export");
  state.worker = "claude";
  const untrusted = AsyncResult.failure(
    Cause.fail(
      new AgentdCommandError({
        message: "Claude Code hasn’t been allowed to work in /repo yet.",
        notSetUp: false,
        untrustedFolder: "/repo",
      }),
    ),
  );
  state.start
    .mockResolvedValueOnce(untrusted)
    .mockResolvedValueOnce(untrusted)
    .mockResolvedValueOnce(
      AsyncResult.success({
        id: "hof-123abc",
        started: true,
        note: null,
      } satisfies AgentdStartTaskResult),
    );
  await using _screen = await renderDialog();
  await fillTask();
  const start = page.getByRole("button", { name: "Start", exact: true });
  const question = page.getByRole("alertdialog");

  await start.click();
  await expect.element(question.getByText("Let Claude Code work in /repo?")).toBeVisible();
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect.element(question).not.toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(state.start).toHaveBeenCalledTimes(1);

  await start.click();
  await question.getByRole("button", { name: "Trust folder" }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledTimes(3);
  expect(state.start.mock.calls[1]![0].input).not.toHaveProperty("trustClaudeFolder");
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: expect.objectContaining({ worker: "claude", trustClaudeFolder: true }),
  });
});

it("starts a cloud task with a dollar cap and a provider key path, without the local branch gate", async () => {
  setup("main");
  state.cloud = {
    supported: true,
    project: "fork-owner/export",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  const option = page.getByRole("checkbox", { name: "Run in the cloud" });
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(option).not.toBeChecked();
  await option.click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await expect.element(page.getByText("Available LibraOS credit: $20.00")).toBeVisible();
  await expect
    .element(page.getByText("Worker time and inference are both billed to LibraOS credits."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("5");
  await expect.element(page.getByLabelText("Time limit in minutes (optional)")).toHaveValue("60");
  await expect.element(start).toBeEnabled();
  await userEvent.fill(page.getByLabelText("Dollar cap (USD)"), "2.50");

  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your API key" }).click();
  const keyPath = page.getByLabelText("Anthropic key file path");
  const openai = page.getByLabelText("OpenAI key file path");
  await userEvent.fill(openai, "/private/openai.key");
  for (const value of ["sk-example/with-separator", "sk-ant-example", "x".repeat(31)]) {
    await userEvent.fill(keyPath, value);
    await expect.element(keyPath).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(
        page.getByText("This looks like the key itself. Save it in a file and choose that file."),
      )
      .toBeVisible();
    await expect.element(start).toBeDisabled();
    expect(state.start).not.toHaveBeenCalled();
  }
  await userEvent.fill(openai, "");
  state.keyFiles["/private/key file"] = {
    provider: "anthropic",
    readable: true,
    openToOthers: false,
  };
  await userEvent.fill(keyPath, "/private/key file");
  await expect.element(page.getByText(/Your provider bills inference separately/)).toBeVisible();
  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: { budget: "60m,$2.50", modelAccess: "byok", anthropicKeyFile: "/private/key file" },
    },
  });
});

it("warns that a cloud task cannot open an issue or a pull request, and offers this computer", async () => {
  setup("main");
  state.cloud = {
    supported: true,
    project: "fork-owner/export",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  const option = page.getByRole("checkbox", { name: "Run in the cloud" });
  const here = page.getByRole("button", { name: "Run on this computer" });
  await option.click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await expect.element(page.getByText("Available LibraOS credit: $20.00")).toBeVisible();
  await expect.element(here).not.toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Goal"), "Reply to the review on PR #12");
  await here.click();
  await expect.element(option).not.toBeChecked();
});

it("fills where and with what budget a task runs from Settings → Workers", async () => {
  setup("feature/export", true, { agentdDefaultBudget: "45m,$3" });
  {
    await using _screen = await renderDialog();
    await expect.element(page.getByLabelText("Budget")).toHaveValue("45m,$3");
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  setup("feature/export", true, { agentdDefaultBudget: "45m,$3", agentdRunTasksOn: "cloud" });
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  const option = page.getByRole("checkbox", { name: "Run in the cloud" });
  await expect.element(option).toBeChecked();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("3");
  await expect.element(page.getByLabelText("Time limit in minutes (optional)")).toHaveValue("45");
  await option.click();
  await expect.element(option).not.toBeChecked();
});

it("checks an unknown cloud outcome before retrying and can replace an earlier submission", async () => {
  setup("main");
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: "30m,$2",
    problem: null,
  };
  const earlier = "0123abcd-ef01-8234-8567-89abcdef0123";
  let answer: (value: unknown) => void = () => {};
  const refused = (fields: {
    message: string;
    outcomeUnknown?: true;
    replaceSubmission?: string;
  }) => AsyncResult.failure(Cause.fail(new AgentdCommandError({ notSetUp: false, ...fields })));
  const unfinished =
    "AgentD hasn’t confirmed your last cloud submission for this project, and it may still start. Replace it with this one? If it started, this one isn’t sent.";
  // The dialog asks in the user's language, whatever text agentd's refusal carries.
  const said = "server question";
  state.start
    .mockResolvedValueOnce(refused({ message: said, replaceSubmission: earlier }))
    .mockResolvedValueOnce(refused({ message: said, replaceSubmission: earlier }))
    .mockResolvedValueOnce(
      refused({ message: "AgentD may have created this cloud task.", outcomeUnknown: true }),
    )
    .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText(unfinished)).toBeVisible();
  // One Cancel only: the footer's, which discards the dialog.
  await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Don’t replace" }).click();
  await expect.element(page.getByText(unfinished)).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  const input = { cwd: "/repo/worktrees/export", goal: "Fix export", accept: [], check: null };
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      ...input,
      cloud: { budget: "30m,$5", modelAccess: "libraos", replaceSubmission: earlier },
    },
  });

  const retry = page.getByRole("button", { name: "Check and retry" });
  await retry.click();
  await expect
    .element(page.getByRole("button", { name: "Checking the earlier submission…" }))
    .toBeDisabled();
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { ...input, cloud: { budget: "30m,$5", modelAccess: "libraos" } },
  });
  // Until agentd records a task, nothing here subscribes to the task list.
  expect(state.tasks).not.toHaveBeenCalled();
  answer(AsyncResult.success({ id: "hof-aabbcc", started: false, note: "Recorded." }));
  await expect.element(page.getByText(/AgentD saved task hof-aabbcc/)).toBeVisible();
  // While the dialog shows it, its task list subscription drives the cloud sync fallback.
  expect(state.tasks).toHaveBeenCalledWith(thread.environmentId);
  // The sync finds the job under way: the dialog no longer says it didn't start.
  state.rows = [{ id: "hof-aabbcc", cloudState: "running" }];
  for (const listener of state.rowListeners) listener();
  await expect
    .element(
      page.getByText(
        "Task hof-aabbcc started in Cloud Workers. Check Background tasks for its progress.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText(/AgentD saved task hof-aabbcc/)).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Start|Check and retry/ }))
    .not.toBeInTheDocument();
  expect(state.start).toHaveBeenCalledTimes(4);
});

it("turns off cloud start if the checkout’s origin is not a GitHub repository", async () => {
  setup("feature/export");
  state.cloud = {
    supported: true,
    project: null,
    balanceUsd: null,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  await expect.element(page.getByRole("checkbox", { name: "Run in the cloud" })).toBeDisabled();
  await expect
    .element(page.getByText("Cloud Workers require a GitHub repository as the checkout’s origin."))
    .toBeVisible();
});

it("does not contact the worker bridge when the checkout is detached before Start", async () => {
  setup("feature/export");
  state.refresh.mockResolvedValue(AsyncResult.success({ isRepo: true, refName: null }));
  await using _screen = await renderDialog();
  await fillTask();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Check out a named branch in this working directory first.");
  expect(state.start).not.toHaveBeenCalled();
});

it("starts from the default branch and says the worker gets its own worktree", async () => {
  setup("main", drafted);
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await expect
    .element(page.getByText("Runs on a new branch in its own worktree, from main."))
    .toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ cwd: "/repo/worktrees/export" }) }),
  );
});

it("runs a draft thread’s task in its project’s checkout", async () => {
  setup("feature/export", drafted);
  state.draft = true;
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "draft-project",
      scopeProjectRef(thread.environmentId, thread.projectId),
      DraftId.make("draft-1"),
      { threadId: thread.id },
    );
  await using _screen = await renderDialog();
  await expect
    .element(page.getByText("This session has no project working directory."))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect.element(page.getByLabelText("Working directory")).toHaveValue("/repo");
});

it("shows a drafted task as one summary with Start and its inputs folded under Edit", async () => {
  setup("feature/export", drafted);
  state.defaults = { estimate, check: "go test ./..." };
  state.gateway = true;
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await expect
    .element(page.getByText("opencode · budget up to $5.00 · LibraOS models · check: pnpm test"))
    .toBeVisible();
  await expect
    .element(page.getByText("Budget up to $5.00 (similar tasks cost $1.78–$4.98)."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Goal")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect.element(page.getByLabelText("Check command")).toHaveValue("pnpm test");
  await expect.element(page.getByLabelText("Budget")).toHaveValue("60m,$5");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: ["Keeps the row order"],
      check: "pnpm test",
      worker: "opencode",
      budget: "60m,$5",
      issue: null,
    },
  });
});

it("budgets in minutes only while agentd has no model prices, and flags typed dollars", async () => {
  setup("feature/export", drafted);
  state.defaults = { estimate, check: null };
  state.dollarBudgets = false;
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await expect
    .element(page.getByText("opencode · time limit 60 min · check: pnpm test"))
    .toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  const budget = page.getByLabelText("Budget");
  await expect.element(budget).toHaveValue("60m");
  await userEvent.fill(budget, "30m,$2");
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(start).toBeDisabled();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "AgentD on this machine has no model prices, so it cannot hold a dollar limit. Use minutes, such as 60m.",
    );
  await userEvent.clear(budget);
  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: ["Keeps the row order"],
      check: "pnpm test",
      worker: "opencode",
      budget: "60m",
      issue: null,
    },
  });
});

it("suggests an editable check for a hand-filled task", async () => {
  setup("feature/export");
  state.defaults = { estimate: null, check: "go test ./..." };
  await using _screen = await renderDialog();
  const check = page.getByLabelText("Check command");
  await expect.element(check).toHaveValue("go test ./...");
  await expect
    .element(page.getByText("Budget up to $5.00 (agentd has no estimate for similar tasks yet)."))
    .toBeVisible();
  await userEvent.fill(check, "go test ./internal/...");
  await expect.element(check).toHaveValue("go test ./internal/...");
  await userEvent.fill(check, "");
  await expect.element(page.getByText("Enter a check command.")).toBeVisible();
});

it.each([
  ["neither signed in nor the Gateway", false, "byok"],
  ["the Gateway", true, "libraos"],
] as const)("defaults cloud model access with %s", async (_name, gateway, access) => {
  setup("feature/export");
  state.gateway = gateway;
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: null,
    balanceText: null,
    defaultBudget: null,
    problem: "balance",
  };
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Model access" }))
    .toHaveTextContent(access === "byok" ? "Your API key" : "LibraOS");
  const keyPath = page.getByLabelText("Anthropic key file path");
  if (access === "byok") await expect.element(keyPath).toBeVisible();
  else await expect.element(keyPath).not.toBeInTheDocument();
});

it("caps a cloud budget by the balance and says the estimate comes from local runs", async () => {
  setup("feature/export", drafted);
  state.defaults = { estimate: { ...estimate, high: 7.2 }, check: null };
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 3.5,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("3.50");
  await expect
    .element(
      page.getByText(
        "Budget up to $3.50 (similar tasks cost $1.78–$7.20). The estimate comes from local runs of similar tasks.",
      ),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByText("Cloud Workers · budget up to $3.50 · LibraOS models · check: pnpm test"),
    )
    .toBeVisible();
});

it.each([
  ["no worker", { worker: null }, "Choose a worker. The default is set in agentd."],
  ["no credit", { balanceUsd: 0 }, "There is not enough LibraOS credit for Cloud Workers."],
  [
    "no LibraOS sign-in",
    { balanceUsd: null, access: "libraos" },
    "Sign in to LibraOS or connect the LibraOS Gateway to use LibraOS models.",
  ],
] as const)("shows %s in one line and disables Start", async (_name, problem, line) => {
  setup("feature/export", drafted);
  if ("worker" in problem) state.worker = problem.worker;
  await using _screen = await renderDialog();
  if ("balanceUsd" in problem) {
    state.cloud = {
      supported: true,
      project: "acme/app",
      balanceUsd: problem.balanceUsd,
      balanceText: null,
      defaultBudget: null,
      problem: problem.balanceUsd === null ? "balance" : null,
    };
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    if ("access" in problem) {
      await page.getByRole("combobox", { name: "Model access" }).click();
      await page.getByRole("option", { name: "LibraOS" }).click();
    }
  }
  await expect.element(page.getByText(line)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
});

it("renders a drafted task as a card that starts it or opens the dialog with its fields", async () => {
  setup("feature/export", false);
  state.defaults = { estimate, check: null };
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <TaskDraftCard threadRef={threadRef} fields={drafted} />
        <StartTaskDialogHost />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
  // The dialog atom outlives a test; close one an earlier test left open.
  if (page.getByRole("dialog").query() !== null) {
    await page.getByRole("button", { name: "Cancel" }).click();
  }
  const card = page.getByRole("region", { name: "Drafted task" });
  await expect.element(card.getByText("Fix export")).toBeVisible();
  await expect
    .element(card.getByText("opencode · budget up to $5.00 · check: pnpm test"))
    .toBeVisible();
  await card.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect
    .element(dialog.getByText("opencode · budget up to $5.00 · check: pnpm test"))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await card.getByRole("button", { name: "Start" }).click();
  await expect.element(card.getByText("Task hof-123abc is in Background tasks.")).toBeVisible();
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: ["Keeps the row order"],
      check: "pnpm test",
      worker: "opencode",
      budget: "60m,$5",
      issue: null,
    },
  });
});

const cloudReady = (fields: Partial<AgentdCloudSetup> = {}): AgentdCloudSetup => ({
  supported: true,
  canConfigure: true,
  setupUrl: "https://cloud-api.libraos.com",
  subscription: null,
  project: "acme/app",
  balanceUsd: 20,
  balanceText: null,
  defaultBudget: null,
  problem: null,
  ...fields,
});
const keyFileEnvironments = [
  { os: "windows", mode: "local", prefix: "C:\\Users\\<you>\\.config\\" },
  { os: "darwin", mode: "remote", prefix: "/Users/<you>/.config/" },
  { os: "linux", mode: "wsl", prefix: "/home/<you>/.config/" },
  { os: "linux", mode: "web", prefix: "/home/<you>/.config/" },
] as const;

it.each(keyFileEnvironments)(
  "uses the $os key file example and offers Browse only on the native desktop ($mode)",
  async ({ os, mode, prefix }) => {
    setup("feature/export");
    state.cloud = cloudReady({ balanceUsd: null });
    state.primary = mode === "remote" ? EnvironmentId.make("other") : thread.environmentId;
    state.os = os;
    const openaiPath = "C:\\Users\\Developer\\.config\\openai.key";
    const pickFiles = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(openaiPath);
    using _bridge = stubGlobal(
      "desktopBridge",
      mode === "web"
        ? undefined
        : {
            pickFiles,
            getLocalEnvironmentBootstraps: () => [
              {
                id: PRIMARY_LOCAL_ENVIRONMENT_ID,
                runningDistro: mode === "wsl" ? "Ubuntu" : null,
                httpBaseUrl: "http://localhost:3773",
                wsBaseUrl: "ws://localhost:3773",
              },
            ],
          },
    );
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    const anthropic = page.getByRole("textbox", { name: "Anthropic key file path" });
    const openai = page.getByRole("textbox", { name: "OpenAI key file path" });
    await expect.element(anthropic).toHaveAttribute("placeholder", prefix + "anthropic.key");
    await expect.element(openai).toHaveAttribute("placeholder", prefix + "openai.key");
    await expect
      .element(
        page.getByText("Save the key on its own line in a text file, then choose that file."),
      )
      .toBeVisible();
    await userEvent.fill(anthropic, prefix + "anthropic.key");
    await expect.element(anthropic).toHaveAttribute("aria-invalid", "false");

    const browse = page.getByRole("button", { name: /^Browse…/ });
    if (mode !== "local") {
      await expect.element(browse).not.toBeInTheDocument();
      return;
    }
    expect(browse.all()).toHaveLength(2);
    await browse.nth(0).click();
    await expect.element(browse.nth(0)).toBeEnabled();
    await expect.element(anthropic).toHaveValue(prefix + "anthropic.key");
    await browse.nth(1).click();
    await expect.element(openai).toHaveValue(openaiPath);
    expect(pickFiles.mock.calls).toEqual([[], []]);
  },
);

const plan = (fields: Partial<AgentdCloudPlanState> = {}): AgentdCloudPlanState => ({
  supported: true,
  configured: true,
  valid: true,
  expiresAbout: null,
  ...fields,
});

it("sets Cloud Workers up from the Start dialog with a pasted key, showing a refusal or the balance", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup" });
  const key = "lcw_live_0123456789abcdefghij";
  state.configure
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new AgentdCommandError({
            message: "The Job API refused this account key. Copy the whole key and try again.",
            notSetUp: false,
          }),
        ),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success({ balanceUsd: 12.5 }));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("link", { name: "Create a key in LibraOS Console" }))
    .toHaveAttribute("href", "https://console.libraos.com/agentd");
  const field = page.getByLabelText("Cloud Workers account key");
  await expect.element(field).toHaveAttribute("type", "password");
  const setUp = page.getByRole("button", { name: "Set up Cloud Workers" });

  await userEvent.fill(field, key);
  await setUp.click();
  await expect.element(page.getByText(/refused this account key/)).toHaveAttribute("role", "alert");
  await expect.element(field).toHaveValue("");
  expect(state.cloudRefresh).not.toHaveBeenCalled();

  await userEvent.fill(field, `${key}\n`);
  await setUp.click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Cloud Workers are set up." }))
    .toHaveTextContent("Cloud Workers are set up. Available LibraOS credit: $12.50");
  const input = { key, url: "https://cloud-api.libraos.com" };
  expect(state.configure.mock.calls).toEqual([
    [{ environmentId: thread.environmentId, input }],
    [{ environmentId: thread.environmentId, input }],
  ]);
  expect(state.cloudRefresh).toHaveBeenCalled();
});

it("names a separately hosted Job API before asking for its key", async () => {
  setup("feature/export");
  const custom = "https://jobs.example.com";
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", setupUrl: custom });
  state.configure.mockResolvedValueOnce(AsyncResult.success({ balanceUsd: null }));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByText(/AgentD sends it to https:\/\/jobs\.example\.com to check it/))
    .toBeVisible();
  await expect.element(page.getByText(/A LibraOS Console key won’t work there/)).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Create a key in LibraOS Console" }))
    .not.toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Cloud Workers account key"), "custom-key");
  await page.getByRole("button", { name: "Set up Cloud Workers" }).click();
  await expect.element(page.getByText("Cloud Workers are set up.")).toBeVisible();
  expect(state.configure).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { key: "custom-key", url: custom },
  });
});

it("asks for no account key while agentd won't say where it would send one", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", setupUrl: null });
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect.element(page.getByLabelText("Cloud Workers account key")).not.toBeInTheDocument();
  await expect
    .element(page.getByText(/didn’t say where it would send an account key/))
    .toBeVisible();
});

it("offers no Keep the current key once a replacement key is on its way", async () => {
  setup("feature/export", false);
  let answer: (value: unknown) => void = () => {};
  state.configure.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  const cancel = vi.fn();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <CloudWorkersSetup
        environmentId={thread.environmentId}
        canConfigure
        setupUrl="https://cloud-api.libraos.com"
        onCancel={cancel}
      />
    </AppAtomRegistryProvider>,
  );
  const keep = page.getByRole("button", { name: "Keep the current key" });
  await expect.element(keep).toBeEnabled();
  await userEvent.fill(page.getByLabelText("Cloud Workers account key"), "new-key");
  await page.getByRole("button", { name: "Set up Cloud Workers" }).click();
  await expect.element(page.getByRole("button", { name: "Setting up…" })).toBeVisible();
  await expect.element(keep).toBeDisabled();
  answer(AsyncResult.success({ balanceUsd: 1 }));
  await expect.element(page.getByText(/Cloud Workers are set up/)).toBeVisible();
  expect(cancel).not.toHaveBeenCalled();
});

it("keeps the Console link and asks for agentd upgrade when agentd has no cloud setup", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", canConfigure: false });
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("link", { name: "Open Cloud Workers setup in LibraOS Console" }))
    .toBeVisible();
  await expect.element(page.getByText(/agentd upgrade$/)).toBeVisible();
  await expect.element(page.getByLabelText("Cloud Workers account key")).not.toBeInTheDocument();
});

it("lists Your subscription as disabled while agentd can't run subscription jobs", async () => {
  setup("feature/export");
  state.cloud = cloudReady();
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await page.getByRole("combobox", { name: "Model access" }).click();
  await expect
    .element(
      page.getByRole("option", { name: "Your subscription (needs AgentD v0.1.14 or later)" }),
    )
    .toHaveAttribute("aria-disabled", "true");
});

it("starts a cloud task on the Claude plan agentd has set up, never choosing it by default", async () => {
  setup("feature/export");
  state.gateway = true;
  state.cloud = cloudReady({
    subscription: {
      claude: plan({ expiresAbout: "2027-11-01" }),
      codex: plan({ supported: false, configured: false, valid: null }),
      setupUnavailable: false,
    },
  });
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  const access = page.getByRole("combobox", { name: "Model access" });
  await expect.element(access).toHaveTextContent("LibraOS");
  await access.click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  await expect
    .element(
      page.getByText("Using the Claude token AgentD has set up. It runs out about Nov 1, 2027."),
    )
    .toBeVisible();
  // The optional file stays folded while agentd has a token, and nothing optional takes focus.
  await expect
    .element(page.getByLabelText("Claude token file path (optional)"))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Use a different token file" }).click();
  await expect.element(page.getByLabelText("Claude token file path (optional)")).toHaveValue("");
  await expect.element(page.getByLabelText("Claude token file path (optional)")).not.toHaveFocus();
  await expect.element(page.getByText(/^Billed to your Claude plan\./)).toBeVisible();
  await expect.element(page.getByText(/budget up to \$5\.00 · your Claude plan/)).toBeVisible();

  await page.getByRole("combobox", { name: "Plan" }).click();
  await expect
    .element(page.getByRole("option", { name: "ChatGPT (Codex): needs a newer AgentD" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: { budget: "60m,$5", modelAccess: "subscription", plan: "claude" },
    },
  });
});

it("says how to set up a plan with no credential, and starts with a chosen file", async () => {
  setup("feature/export");
  state.cloud = cloudReady({
    subscription: {
      claude: plan({ configured: false, valid: null }),
      codex: plan({ configured: false, valid: null }),
      setupUnavailable: false,
    },
  });
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(page.getByText(/claude setup-token$/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect
    .element(page.getByText("Set up your Claude plan, or choose another model access."))
    .toBeVisible();
  await expect.element(start).toBeDisabled();

  await page.getByRole("combobox", { name: "Plan" }).click();
  await page.getByRole("option", { name: "ChatGPT (Codex)" }).click();
  await expect.element(page.getByText(/codex login$/)).toBeVisible();
  await expect
    .element(page.getByText(/absolute path of Codex’s auth.json on that machine/))
    .toBeVisible();
  await expect.element(page.getByText(/^Billed to your ChatGPT plan\./)).toBeVisible();
  await userEvent.fill(
    page.getByLabelText("ChatGPT auth.json path (optional)"),
    "/home/me/.codex/auth.json",
  );
  await expect.element(start).toBeEnabled();
  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: {
        budget: "60m,$5",
        modelAccess: "subscription",
        plan: "codex",
        codexAuthFile: "/home/me/.codex/auth.json",
      },
    },
  });
});

it("keeps each model access mode's key paths to itself and submits only the shown ones", async () => {
  setup("feature/export");
  state.cloud = cloudReady({
    subscription: {
      claude: plan({ configured: false, valid: null }),
      codex: plan({ configured: false, valid: null }),
      setupUnavailable: false,
    },
  });
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  const access = page.getByRole("combobox", { name: "Model access" });
  await access.click();
  await page.getByRole("option", { name: "Your API key" }).click();
  await userEvent.fill(page.getByLabelText("OpenAI key file path"), "/home/me/openai.key");

  await access.click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  const token = page.getByLabelText("Claude token file path (optional)");
  await expect.element(token).toHaveValue("");
  await expect.element(token).not.toHaveFocus();
  await userEvent.fill(token, "/home/me/claude.token");

  await access.click();
  await page.getByRole("option", { name: "Your API key" }).click();
  await expect
    .element(page.getByLabelText("OpenAI key file path"))
    .toHaveValue("/home/me/openai.key");
  await expect.element(page.getByLabelText("Anthropic key file path")).toHaveValue("");

  await access.click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  await expect.element(token).toHaveValue("/home/me/claude.token");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: {
        budget: "60m,$5",
        modelAccess: "subscription",
        plan: "claude",
        claudeTokenFile: "/home/me/claude.token",
      },
    },
  });
});

it.each([
  {
    unanswered: "agentd",
    reason:
      "Couldn’t reach AgentD to check Cloud Workers. Retry, or choose Edit and turn off Run in the cloud to run this task here.",
  },
  {
    unanswered: "git",
    reason:
      "Couldn’t read this checkout’s origin for Cloud Workers. Retry, or choose Edit and turn off Run in the cloud to run this task here.",
  },
])(
  "keeps a cloud Start in the cloud while $unanswered doesn't answer the probe, until turned off",
  async ({ unanswered, reason }) => {
    setup("feature/export", false, { agentdRunTasksOn: "cloud" });
    if (unanswered === "agentd") state.cloudError = new Error("agentd timed out");
    else state.cloud = cloudReady({ project: null, checkoutUnknown: true });
    state.start.mockResolvedValue(
      AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
    );
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <ToastProvider>
          <TaskDraftCard threadRef={threadRef} fields={{ ...drafted, budget: "30m,$2" }} />
          <StartTaskDialogHost />
        </ToastProvider>
      </AppAtomRegistryProvider>,
    );
    const card = page.getByRole("region", { name: "Drafted task" });
    await expect.element(card.getByText(reason)).toBeVisible();
    await expect.element(card.getByRole("button", { name: "Start" })).toBeDisabled();
    // The cap shown is the cloud's, never the drafted local budget.
    await expect
      .element(card.getByText("Cloud Workers · budget up to $5.00 · check: pnpm test"))
      .toBeVisible();
    await card.getByRole("button", { name: "Retry" }).click();
    expect(state.cloudRefresh).toHaveBeenCalled();

    openStartTaskDialog(threadRef, drafted);
    const dialog = page.getByRole("dialog");
    const start = dialog.getByRole("button", { name: "Start", exact: true });
    const option = dialog.getByRole("checkbox", { name: "Run in the cloud" });
    await expect.element(option).toBeChecked();
    await expect.element(start).toBeDisabled();
    await expect.element(dialog.getByLabelText("Worker")).not.toBeInTheDocument();
    await dialog.getByRole("button", { name: "Retry" }).click();
    // Only turning cloud off runs the task here.
    await option.click();
    await expect.element(start).toBeEnabled();
    await start.click();
    await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
    expect(state.start).toHaveBeenCalledExactlyOnceWith({
      environmentId: thread.environmentId,
      input: expect.objectContaining({ worker: "opencode" }),
    });
  },
);

it("answers a replacement question on the draft card itself", async () => {
  setup("feature/export", false, { agentdRunTasksOn: "cloud" });
  state.cloud = cloudReady();
  const earlier = "0123abcd-ef01-8234-8567-89abcdef0123";
  const question = AsyncResult.failure(
    Cause.fail(
      new AgentdCommandError({
        message: "server question",
        notSetUp: false,
        replaceSubmission: earlier,
      }),
    ),
  );
  state.start
    .mockResolvedValueOnce(question)
    .mockResolvedValueOnce(question)
    .mockResolvedValueOnce(AsyncResult.success({ id: "hof-123abc", started: true, note: null }));
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <TaskDraftCard threadRef={threadRef} fields={drafted} />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
  const card = page.getByRole("region", { name: "Drafted task" });
  const asked = card.getByText(/Replace it with this one\?/);
  await card.getByRole("button", { name: "Start" }).click();
  await expect.element(asked).toBeVisible();
  await card.getByRole("button", { name: "Don’t replace" }).click();
  await expect.element(asked).not.toBeInTheDocument();
  await card.getByRole("button", { name: "Start" }).click();
  await card.getByRole("button", { name: "Replace", exact: true }).click();
  await expect.element(card.getByText(/Task hof-123abc is in Background tasks/)).toBeVisible();
  expect(state.start).toHaveBeenCalledTimes(3);
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: expect.objectContaining({
      cloud: expect.objectContaining({ replaceSubmission: earlier }),
    }),
  });
});

it("follows a cloud task the draft card saved but agentd didn't confirm until it starts", async () => {
  setup("feature/export", false, { agentdRunTasksOn: "cloud" });
  state.cloud = cloudReady();
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-aabbcc", started: false, note: "Recorded." }),
  );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <TaskDraftCard threadRef={threadRef} fields={drafted} />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
  const card = page.getByRole("region", { name: "Drafted task" });
  expect(state.tasks).not.toHaveBeenCalled();
  await card.getByRole("button", { name: "Start" }).click();
  await expect.element(card.getByText("Recorded.")).toBeVisible();
  // Its task list subscription drives the cloud sync fallback with the tasks pane closed.
  expect(state.tasks).toHaveBeenCalledWith(thread.environmentId);
  state.rows = [{ id: "hof-aabbcc", cloudState: "running" }];
  for (const listener of state.rowListeners) listener();
  await expect
    .element(
      card.getByText(
        "Task hof-aabbcc started in Cloud Workers. Check Background tasks for its progress.",
      ),
    )
    .toBeVisible();
  await expect.element(card.getByText("Recorded.")).not.toBeInTheDocument();
});

it("offers Retry on the AgentD page when agentd didn't answer the cloud probe", async () => {
  setup("feature/export", false);
  state.cloud = { ...cloudReady(), unreachable: true };
  await using _screen = await render(<AgentdPageCloud environmentId={thread.environmentId} />);
  await expect.element(page.getByText("LibraOS balance unavailable.")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(state.cloudRefresh).toHaveBeenCalled();
});

it("keeps Start disabled until each BYOK path is checked, and says when one can't be read or checked", async () => {
  setup("feature/export");
  state.cloud = cloudReady();
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your API key" }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  const anthropic = page.getByLabelText("Anthropic key file path");
  await userEvent.fill(anthropic, "/home/me/new.key");
  await expect.element(page.getByText("Checking this key file…")).toBeVisible();
  await expect.element(start).toBeDisabled();

  state.keyFiles["/home/me/gone.key"] = { provider: null, readable: false, openToOthers: false };
  await userEvent.fill(anthropic, "/home/me/gone.key");
  await expect
    .element(page.getByText(/Couldn’t read \/home\/me\/gone.key on this environment’s machine/))
    .toBeVisible();
  await expect.element(start).toBeDisabled();
  expect(state.start).not.toHaveBeenCalled();
  // Recreated at the same path: Check again reads it again.
  state.keyFiles["/home/me/gone.key"] = {
    provider: "anthropic",
    readable: true,
    openToOthers: false,
  };
  await page.getByRole("button", { name: "Check again" }).click();
  await expect.element(start).toBeEnabled();

  // A connection without filesystem read can't check the file: agentd checks it on Start.
  state.keyFilesDenied.add("/home/me/team.key");
  await userEvent.fill(anthropic, "/home/me/team.key");
  await expect
    .element(page.getByText(/This connection can’t read files on this environment’s machine/))
    .toBeVisible();
  await expect.element(start).toBeEnabled();
});

it("checks each BYOK key file's provider and privacy, and remembers the paths that were sent, closed or not", async () => {
  setup("feature/export");
  state.cloud = cloudReady();
  state.keyFiles = {
    "/home/me/anthropic.key": { provider: "anthropic", readable: true, openToOthers: false },
    "/home/me/shared.key": { provider: "openai", readable: true, openToOthers: true },
    "/home/me/openai.key": { provider: "openai", readable: true, openToOthers: false },
  };
  state.fixKeyFile.mockResolvedValue(
    AsyncResult.success({ provider: "openai", readable: true, openToOthers: false }),
  );
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  {
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
    await page.getByRole("combobox", { name: "Model access" }).click();
    await page.getByRole("option", { name: "Your API key" }).click();
    const start = page.getByRole("button", { name: "Start", exact: true });
    const openai = page.getByLabelText("OpenAI key file path");
    await userEvent.fill(openai, "/home/me/anthropic.key");
    await expect
      .element(page.getByText("This is an Anthropic key; choose it under Anthropic key file."))
      .toBeVisible();
    await expect.element(start).toBeDisabled();

    await userEvent.fill(openai, "/home/me/shared.key");
    await expect
      .element(
        page.getByText(
          "/home/me/shared.key can be read by other users. Run chmod 600 /home/me/shared.key, then try again.",
        ),
      )
      .toBeVisible();
    await expect.element(start).toBeDisabled();
    await page.getByRole("button", { name: "Fix permissions" }).click();
    expect(state.fixKeyFile).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      input: { path: "/home/me/shared.key" },
    });
    // Fixed in a terminal instead: Check again reads the same path anew.
    state.keyFiles["/home/me/shared.key"] = {
      provider: "openai",
      readable: true,
      openToOthers: false,
    };
    await page.getByRole("button", { name: "Check again" }).click();
    await expect.element(page.getByText(/can be read by other users/)).not.toBeInTheDocument();
    await expect.element(start).toBeEnabled();

    await userEvent.fill(openai, "/home/me/openai.key");
    await expect.element(start).toBeEnabled();
    await start.click();
    await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  }
  // The next task starts with the path that was sent, in its own field.
  openStartTaskDialog(threadRef);
  {
    // A task agentd recorded but the cloud didn't take keeps the last path that worked.
    state.keyFiles["/home/me/other.key"] = {
      provider: "openai",
      readable: true,
      openToOthers: false,
    };
    state.start.mockResolvedValue(
      AsyncResult.success({ id: "hof-456def", started: false, note: "Refused." }),
    );
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
    await page.getByRole("combobox", { name: "Model access" }).click();
    await page.getByRole("option", { name: "Your API key" }).click();
    await userEvent.fill(page.getByLabelText("OpenAI key file path"), "/home/me/other.key");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Refused.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
  }
  openStartTaskDialog(threadRef);
  {
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    await page.getByRole("combobox", { name: "Model access" }).click();
    await page.getByRole("option", { name: "Your API key" }).click();
    await expect
      .element(page.getByLabelText("OpenAI key file path"))
      .toHaveValue("/home/me/openai.key");
    await expect.element(page.getByLabelText("Anthropic key file path")).toHaveValue("");
    // An earlier submission's task agentd found isn't this draft's: never shown as its start, and
    // its paths aren't kept.
    state.keyFiles["/home/me/draft.key"] = {
      provider: "openai",
      readable: true,
      openToOthers: false,
    };
    state.start.mockResolvedValue(
      AsyncResult.success({ id: "hof-777eee", started: false, earlier: true, note: "Earlier." }),
    );
    await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
    await userEvent.fill(page.getByLabelText("OpenAI key file path"), "/home/me/draft.key");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Earlier.")).toBeVisible();
    await expect.element(page.getByText(/AgentD saved task hof-777eee/)).not.toBeInTheDocument();
    state.rows = [{ id: "hof-777eee", cloudState: "running" }];
    for (const listener of state.rowListeners) listener();
    await expect
      .element(page.getByText(/Task hof-777eee started in Cloud Workers/))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Earlier.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
  }
  openStartTaskDialog(threadRef);
  {
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    await page.getByRole("combobox", { name: "Model access" }).click();
    await page.getByRole("option", { name: "Your API key" }).click();
    await expect
      .element(page.getByLabelText("OpenAI key file path"))
      .toHaveValue("/home/me/openai.key");
    // One agentd saved without a receipt keeps its path once sync shows it started, after the
    // dialog was closed too.
    state.keyFiles["/home/me/later.key"] = {
      provider: "openai",
      readable: true,
      openToOthers: false,
    };
    state.start.mockResolvedValue(
      AsyncResult.success({ id: "hof-789aaa", started: false, note: "Recorded." }),
    );
    await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
    await userEvent.fill(page.getByLabelText("OpenAI key file path"), "/home/me/later.key");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.element(page.getByText("Recorded.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect.element(page.getByText("Recorded.")).not.toBeInTheDocument();
    state.rows = [{ id: "hof-789aaa", cloudState: "running" }];
    for (const listener of state.rowListeners) listener();
  }
  openStartTaskDialog(threadRef);
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your API key" }).click();
  await expect
    .element(page.getByLabelText("OpenAI key file path"))
    .toHaveValue("/home/me/later.key");
});
