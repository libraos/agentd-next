import {
  AgentdNotFoundError,
  CheckpointRef,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type AgentdTask,
  type AgentdTaskRow,
  type RepositoryIdentity,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  checkpoints: [] as readonly ThreadCheckpointSummary[],
  repositoryIdentity: null as RepositoryIdentity | null,
  projection: null as ThreadStructure | null,
  tasks: null as readonly AgentdTaskRow[] | null,
  taskDetail: null as Pick<AgentdTask, "goal" | "started"> | null,
  stopTask: vi.fn(),
}));

// The read of t3.json is a cache: a re-read is the only way to see what is on disk now.
const t3File = vi.hoisted(() => ({
  disk: "",
  cached: "",
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/components/files/projectFilesQueryState"), async (importOriginal) => {
  const actual = await importOriginal();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useProjectFileQuery: ((_environmentId: unknown, _cwd: string, relativePath: string | null) => {
      const contents = useSyncExternalStore(
        (listener) => {
          t3File.listeners.add(listener);
          return () => t3File.listeners.delete(listener);
        },
        () => t3File.cached,
      );
      const refresh = () => {
        t3File.cached = t3File.disk;
        for (const listener of t3File.listeners) listener();
      };
      const data =
        relativePath === "t3.json" && contents !== ""
          ? { relativePath, contents, byteLength: contents.length, truncated: false }
          : null;
      return {
        data,
        error: null,
        isPending: false,
        readError: null,
        isNotFile: false,
        isFile: data !== null,
        refresh,
      };
    }) as never,
  };
});

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
          workspaceRoot: state.workspaceRoot,
          repositoryIdentity: state.repositoryIdentity,
          scripts: [],
        }) as never,
  useProjects: (() => []) as never,
  useThreadCheckpointSummaries: () => state.checkpoints,
  useQuietThreadProjection: ((ref: ScopedThreadRef | null) =>
    ref === null || state.projection === null ? null : { projection: state.projection }) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: state.folder,
          branch: null,
          pullRequests: state.pullRequests,
        }) as never,
  useServerConfigs: (() =>
    new Map(
      state.configLoaded
        ? [
            [
              EnvironmentId.make("environment"),
              {
                scratchWorkspaceRoot: SCRATCH_ROOT,
                environment: { capabilities: { pullRequests: true } },
              },
            ],
          ]
        : [],
    )) as never,
}));

vi.mock(import("~/lib/agentdState"), async (importOriginal) => {
  const actual = await importOriginal();
  const permitted = Atom.make(true);
  return {
    ...actual,
    agentdEnvironment: {
      ...actual.agentdEnvironment,
      stopTask: { ...actual.agentdEnvironment.stopTask, permissionAtom: () => permitted },
    },
    useAgentdTasks: (() => ({
      data: state.tasks,
      failure: state.tasks === null ? new AgentdNotFoundError({ message: "missing" }) : null,
    })) as typeof actual.useAgentdTasks,
    useAgentdTask: ((id) => ({
      data: id === "hof-000001" ? state.taskDetail : null,
    })) as typeof actual.useAgentdTask,
    useAgentdCommands: () => ({ ...actual.useAgentdCommands(), stopTask: state.stopTask }),
  };
});

vi.mock(import("~/hooks/useNowSecond"), () => ({
  useNowSecond: () => Date.parse("2026-11-18T10:01:33Z"),
}));
// Neither folder is a repository, which is what the server reports for both.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});

import { render } from "../../../test/render";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  checkpoints?: readonly ThreadCheckpointSummary[];
  contextWindow?: ContextWindowSnapshot | null;
  repositoryIdentity?: RepositoryIdentity;
  projection?: ThreadStructure;
  tasks?: readonly AgentdTaskRow[];
  taskDetail?: Pick<AgentdTask, "goal" | "started">;
}) {
  state.configLoaded = input.configLoaded ?? true;
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  state.checkpoints = input.checkpoints ?? [];
  state.repositoryIdentity = input.repositoryIdentity ?? null;
  state.projection = input.projection ?? null;
  state.tasks = input.tasks ?? null;
  state.taskDetail = input.taskDetail ?? null;
  state.stopTask.mockReset();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    contextWindow: input.contextWindow ?? null,
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const machines = (["This Mac", "Server"] as const).map((label, index) => ({
  environmentId: EnvironmentId.make(index === 0 ? "environment" : "other"),
  projectId: ProjectId.make("project"),
  label,
  isPrimary: index === 0,
  machine: "server" as const,
}));

function Panel({
  fixture,
  draftEnvMode,
  onMachines = false,
  withScripts = false,
}: {
  fixture: ReturnType<typeof setup>;
  /** Renders an unsent draft in this mode instead of a started thread. */
  draftEnvMode?: "local" | "worktree";
  onMachines?: boolean;
  withScripts?: boolean;
}) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath={draftEnvMode === undefined ? state.folder : null}
        isServerThread={draftEnvMode === undefined}
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={withScripts ? [] : undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={false}
        offersWorkspaceModes={false}
        envLocked={draftEnvMode === undefined}
        availableEnvironments={onMachines ? machines : []}
        {...(onMachines ? { onEnvironmentChange: noop } : {})}
        onEnvModeChange={noop}
        envMode={draftEnvMode ?? "local"}
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{
          providerInstanceId: null,
          model: null,
          providers: [],
          sources: [],
          contextWindow: fixture.contextWindow,
        }}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows Current checkout where no worktree can come from, even when New worktree is the default", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(<Panel fixture={fixture} draftEnvMode="worktree" />);
  await expect.element(page.getByLabelText("Run context: Current checkout")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Run context/ })).not.toBeInTheDocument();
});

it("offers only machines where no worktree can come from and several machines exist", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(
    <Panel fixture={fixture} draftEnvMode="worktree" onMachines />,
  );
  await page.getByRole("button", { name: "Run context: This Mac, Current checkout" }).click();
  await expect.element(page.getByText("Run on")).toBeVisible();
  await expect.element(page.getByText("New worktree")).not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("heading", { name: "Environment" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Context" })).toBeVisible();
  await expect.element(page.getByText("Not reported by this agent")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Outputs" })).toBeVisible();
  const tasks = page.getByRole("region", { name: "Background tasks" });
  await expect.element(tasks.getByText("LibraOS Engine was not found.")).toBeVisible();
  await expect.element(tasks.getByText(/finished/)).not.toBeInTheDocument();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

function agentdRow(index: number, overrides: Partial<AgentdTaskRow> = {}): AgentdTaskRow {
  return {
    id: `hof-${String(index).padStart(6, "0")}`,
    title: `Task ${index}`,
    state: "claimed",
    workerState: "running",
    workerRunning: true,
    workerTool: null,
    runsOn: "local",
    project: "Team/Repo",
    issue: null,
    started: null,
    branch: null,
    updated: null,
    ...overrides,
  };
}

it("limits background tasks to this project and session, confirms Stop, and opens the pane", async () => {
  const projection = {
    ...makeThreadProjectionFixture(),
    providerThreads: [
      {
        id: "provider-thread",
        pendingBackgroundTasks: [
          { taskId: "server", kind: "command", description: "Start the preview server" },
          { taskId: "watcher", kind: "monitor", description: "Watch checks" },
        ],
      },
    ],
    runs: [{ id: RunId.make("completed-run"), ordinal: 1, status: "completed" }],
  } as unknown as ThreadStructure;
  using fixture = setup({
    workspaceRoot: "C:\\work\\repo",
    folder: "C:\\work\\repo",
    repositoryIdentity: {
      canonicalKey: "github.com/team/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:team/repo",
      },
    },
    projection,
    taskDetail: { goal: "Build the project", started: "2026-11-18T10:00:00Z" },
    tasks: [
      agentdRow(98, { project: "other/repo", title: "Unrelated worker" }),
      agentdRow(99, { project: null, title: "Worker without a project" }),
      agentdRow(1),
      agentdRow(2),
      agentdRow(3),
      agentdRow(4),
      agentdRow(5),
      agentdRow(6, { state: "done", workerRunning: false }),
      agentdRow(7, { state: "cancelled", workerRunning: false }),
      agentdRow(8, { state: "offered", workerRunning: false }),
      agentdRow(9, { project: "other/repo", state: "done", workerRunning: false }),
    ],
  });
  await using _screen = await render(
    <>
      <Panel fixture={fixture} />
      <ConfirmDialogHost />
    </>,
  );
  const region = page.getByRole("region", { name: "Background tasks" });
  const row = region.getByRole("button", { name: /Build the project/ }).first();
  await expect.element(row.getByText("1m 33s", { exact: true })).toBeVisible();
  await expect
    .element(region.getByRole("button", { name: /Start the preview server/ }))
    .toBeVisible();
  await expect.element(region.getByRole("button", { name: /Task 4/ }).first()).toBeVisible();
  await expect.element(region.getByText("Task 5")).not.toBeInTheDocument();
  await expect.element(region.getByText("Watch checks")).not.toBeInTheDocument();
  await expect.element(region.getByText("Unrelated worker")).not.toBeInTheDocument();
  await expect.element(region.getByText("Worker without a project")).not.toBeInTheDocument();

  const stop = region.getByRole("button", { name: "Stop Build the project" });
  const confirmation = page.getByRole("alertdialog", { name: "Stop this background task?" });
  await stop.click();
  await expect.element(confirmation).toBeVisible();
  expect(state.stopTask).not.toHaveBeenCalled();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  expect(state.stopTask).not.toHaveBeenCalled();
  await stop.click();
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  expect(state.stopTask).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { id: "hof-000001", reason: "Stopped from the session panel." },
  });
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBeNull();

  for (const entry of [
    row,
    region.getByRole("button", { name: "Background tasks", exact: true }),
    region.getByRole("button", { name: "2 finished" }),
  ]) {
    useRightPanelStore.getState().closeAllSurfaces(threadRef);
    await entry.click();
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
      "background-tasks",
    );
  }
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Environment" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("opens the latest diff for a repeated output and offers the rest beyond eight rows", async () => {
  const olderRunId = RunId.make("older");
  const latestRunId = RunId.make("latest");
  const file = (path: string) => ({ path, kind: "modified", additions: 2, deletions: 1 });
  const checkpoint = (runId: RunId, count: number, paths: string[]): ThreadCheckpointSummary => ({
    runId,
    checkpointTurnCount: count,
    checkpointRef: CheckpointRef.make(`refs/checkpoints/${runId}`),
    status: "ready",
    files: paths.map(file),
    assistantMessageId: null,
    completedAt: `2026-11-0${count}T00:00:00.000Z`,
  });
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    contextWindow: deriveLatestContextWindowSnapshot([], {
      usedTokens: 25_000,
      maxTokens: 100_000,
      updatedAt: "2026-11-02T00:00:00.000Z",
    }),
    checkpoints: [
      checkpoint(olderRunId, 1, ["src/Older.ts", "latest.ts", "ninth.ts"]),
      checkpoint(latestRunId, 2, ["latest.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]),
    ],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  const context = page.getByRole("region", { name: "Context" });
  await expect.element(context.getByText("25% used")).toBeVisible();
  await expect.element(context.getByText("25k / 100k")).toBeVisible();
  const outputs = page.getByRole("region", { name: "Outputs" });
  const rows = outputs.getByRole("button", { name: /^Open diff for / });
  await expect.element(rows).toHaveLength(8);
  await expect.element(rows.first()).toHaveAccessibleName("Open diff for latest.ts");
  await expect.element(rows.last()).toHaveAccessibleName("Open diff for src/Older.ts");

  await rows.last().click();
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe("diff");
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "turn",
    turnId: olderRunId,
    filePath: "src/Older.ts",
  });

  await rows.first().click();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "turn",
    turnId: latestRunId,
    filePath: "latest.ts",
  });

  await outputs.getByRole("button", { name: "Show all" }).click();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "turn",
    turnId: latestRunId,
    filePath: null,
  });
});

it("lists the t3.json actions on disk when the actions menu opens again after the file changed", async () => {
  using fixture = setup({ workspaceRoot: "/work/plain", folder: "/work/plain" });
  const t3Json = (name: string) =>
    JSON.stringify({ scripts: [{ name, command: `npm run dev -- --port ${name.slice(-4)}` }] });
  t3File.disk = t3Json("Dev 4100");
  t3File.cached = t3File.disk;
  await using _screen = await render(<Panel fixture={fixture} withScripts />);

  const chooser = page.getByRole("button", { name: "Choose project action" });
  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4100/ })).toBeVisible();
  await chooser.click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // A setup hook rewrites this checkout's t3.json outside T3 Code.
  t3File.disk = t3Json("Dev 4200");

  await chooser.click();
  await expect.element(page.getByRole("menuitem", { name: /Dev 4200/ })).toBeVisible();
});
