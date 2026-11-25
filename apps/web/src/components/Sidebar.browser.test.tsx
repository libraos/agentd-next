import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { rememberSidebarTabThread, setSidebarTab } from "../sidebarTabStore";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useUiStateStore } from "../uiStateStore";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useScratchProject", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
    { key: "mod+shift+[", command: "thread.previous" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

// regression: #38623 unsent drafts are listed above threads but mod+1..9 skipped them
describe("sidebar numbered jumps", () => {
  it("numbers the unsent draft at the top before the threads below it", async () => {
    const initial = useComposerDraftStore.getState();
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.setState(initial, true));
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const web = project("web");
    vi.mocked(useProjects).mockReturnValue([web]);
    const thread = threadShell(web.id, 0);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    const draftId = DraftId.make("unsent-draft");
    initial.setProjectDraftThreadId(scopeProjectRef(web.environmentId, web.id), draftId, {
      threadId: ThreadId.make("unsent-draft-thread"),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    initial.setPrompt(draftId, "Unsent prompt");

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const draftRow = screen.getByTestId("sidebar-draft-row");
    await expect.element(draftRow).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+1")).toBeVisible();
    await expect.element(draftRow.getByText("Ctrl+1")).toBeVisible();
    await expect.element(screen.getByText("Ctrl+2")).toBeVisible();
    await userEvent.keyboard("{/Control}");

    // Previous thread from the open thread steps up to the draft above it.
    await userEvent.keyboard("{Control>}{Shift>}{BracketLeft}{/Shift}{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}2{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).not.toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}1{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

it("groups sessions under project and machine headings with default settings", async () => {
  using stack = new DisposableStack();
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const local = project("Local project");
  const remote = { ...project("Remote project"), environmentId: EnvironmentId.make("remote") };
  const startThread = vi.fn().mockResolvedValue(null);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(local.environmentId);
  vi.mocked(useEnvironmentIdentities).mockReturnValue([
    { environmentId: local.environmentId, label: "Local host" },
    { environmentId: remote.environmentId, label: "Build server" },
  ]);
  vi.mocked(useProjects).mockReturnValue([local, remote]);
  vi.mocked(useQuietThreadShells).mockReturnValue([threadShell(local.id, 1)]);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    defaultProjectFallbackReady: true,
    handleNewThread: startThread,
    routeDraftId: null,
    routeThreadRef: null,
  });
  await using screen = await render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );

  await expect
    .element(screen.getByRole("heading", { name: "Local project This computer" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Remote project Build server" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Thread 1, Local project", exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "New session in Remote project" }));
  expect(startThread).toHaveBeenCalledExactlyOnceWith({
    environmentId: remote.environmentId,
    projectId: remote.id,
  });
});

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });

  it("opens Settled when every listed thread is settled and no project is chosen", async () => {
    localStorage.removeItem("t3code:sidebar:settled-expanded");
    const imported = project("imported");
    vi.mocked(useProjects).mockReturnValue([imported]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      makeThreadFixture({
        environmentId: imported.environmentId,
        projectId: imported.id,
        id: ThreadId.make("imported-1"),
        title: "Imported thread",
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    vi.mocked(useThreadRouteTarget).mockReturnValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: imported.environmentId, projectId: imported.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          imported.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const importedRow = () => screen.getByText("Imported thread", { exact: true });
    const shelf = () =>
      screen.container.querySelector<HTMLElement>('[data-sidebar-row="shelf:settled"]')!;

    await expect.element(importedRow()).toBeVisible();
    expect(shelf().getAttribute("aria-expanded")).toBe("true");

    await act(() => shelf().click());
    await expect.poll(() => importedRow().elements()).toHaveLength(0);
  });

  it("opens Settled for a chosen project whose threads are all settled, until it is closed", async () => {
    localStorage.removeItem("t3code:sidebar:settled-expanded");
    const imported = project("imported");
    const busy = project("busy");
    const threads = [
      threadShell(busy.id, 1),
      makeThreadFixture({
        environmentId: imported.environmentId,
        projectId: imported.id,
        id: ThreadId.make("imported-1"),
        title: "Imported thread",
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    vi.mocked(useProjects).mockReturnValue([imported, busy]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: busy.environmentId, projectId: busy.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          imported.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    const keyOf = (p: Project) =>
      deriveLogicalProjectKeyFromSettings(
        p,
        selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
      );
    const scope = (p: Project | null) =>
      act(() => useUiStateStore.getState().setSidebarProjectScopeKeys(p ? [keyOf(p)] : []));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const importedRow = () => screen.getByText("Imported thread", { exact: true });
    const shelf = () =>
      screen.container.querySelector<HTMLElement>('[data-sidebar-row="shelf:settled"]')!;

    // All projects: the settled shelf stays as the user left it, closed.
    await expect.element(screen.getByText("Thread 1", { exact: true })).toBeVisible();
    expect(importedRow().elements()).toHaveLength(0);

    await scope(imported);
    await expect.element(importedRow()).toBeVisible();
    expect(shelf().getAttribute("aria-expanded")).toBe("true");

    await act(() => shelf().click());
    await expect.poll(() => importedRow().elements()).toHaveLength(0);

    // A project with other threads keeps the shelf closed.
    await scope(busy);
    expect(shelf()?.getAttribute("aria-expanded") ?? "false").toBe("false");
    await scope(null);
  });
});

describe("sidebar Chat and Code tabs", () => {
  const scratch = { ...project("scratch"), workspaceRoot: "/home/a/scratch" };
  const app = project("app");
  const scratchChat = makeThreadFixture({
    environmentId: scratch.environmentId,
    projectId: scratch.id,
    id: ThreadId.make("scratch-chat"),
    title: "Scratch chat",
  });
  const appThread = threadShell(app.id, 1);

  function setup(options: {
    threads: ReadonlyArray<EnvironmentThreadShell>;
    route: ScopedThreadRef | null;
    /** Opens an unsent draft in this project instead of `route`. */
    draftIn?: Project;
  }) {
    const stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    stack.defer(() => setSidebarTab("code"));
    const initialDrafts = useComposerDraftStore.getState();
    stack.defer(() => useComposerDraftStore.setState(initialDrafts, true));
    const draftId = DraftId.make("open-draft");
    if (options.draftIn) {
      initialDrafts.setProjectDraftThreadId(
        scopeProjectRef(options.draftIn.environmentId, options.draftIn.id),
        draftId,
        { threadId: ThreadId.make("open-draft-thread"), createdAt: "2026-01-02T00:00:00.000Z" },
      );
    }
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const startScratchThread = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useScratchProject).mockReturnValue({
      scratchEnvironmentId: () => scratch.environmentId,
      scratchWorkspaceRootFor: () => scratch.workspaceRoot,
      openScratchProject: vi.fn().mockResolvedValue(null),
      startScratchThread,
    });
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(scratch.environmentId);
    vi.mocked(useProjects).mockReturnValue([scratch, app]);
    vi.mocked(useQuietThreadShells).mockReturnValue(options.threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue(
      options.draftIn
        ? { kind: "draft", draftId }
        : options.route
          ? { kind: "server", threadRef: options.route }
          : null,
    );
    const handleNewThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: app.environmentId, projectId: app.id },
      defaultProjectFallbackReady: true,
      handleNewThread,
      routeDraftId: options.draftIn ? draftId : null,
      routeThreadRef: options.draftIn ? null : options.route,
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          scratch.environmentId,
          {
            scratchWorkspaceRoot: scratch.workspaceRoot,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    return { stack, startScratchThread, handleNewThread };
  }

  const renderSidebar = () =>
    render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

  it("lists chats under Chat and project sessions under Code", async () => {
    using _setup = setup({ threads: [scratchChat, appThread], route: null }).stack;
    await using screen = await renderSidebar();
    const chatRow = () => screen.getByText("Scratch chat", { exact: true });
    const codeRow = () => screen.getByText("Thread 1", { exact: true });

    await expect.element(codeRow()).toBeVisible();
    expect(chatRow().elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Chat", exact: true }));
    await expect.element(chatRow()).toBeVisible();
    await expect.poll(() => codeRow().elements()).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Filter threads by project" }).elements(),
    ).toHaveLength(0);
  });

  it("Chat and Code each count and page only their own Settled threads, and Chat points to Code", async () => {
    localStorage.setItem("t3code:sidebar:settled-expanded", "true");
    using _expanded = {
      [Symbol.dispose]: () => localStorage.removeItem("t3code:sidebar:settled-expanded"),
    };
    const settledChat = {
      ...scratchChat,
      settledOverride: "settled" as const,
      settledAt: "2026-01-01T00:00:00.000Z",
    };
    // The server holds 37 older settled project sessions and 3 older settled chats this client
    // has not loaded; asked for every project, it counts both.
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      unloadedCount: () =>
        input.scopes.some((scope) => scope.projectIds === null)
          ? 40
          : input.scopes.some((scope) => scope.projectIds?.includes(app.id))
            ? 37
            : 0,
    }));
    using _setup = setup({ threads: [settledChat, appThread], route: null }).stack;
    await using screen = await renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Chat", exact: true }));
    const settledHeader = () => screen.getByTestId("sidebar-settled-shelf-toggle");

    await expect.element(screen.getByText("Scratch chat", { exact: true })).toBeVisible();
    await expect.element(settledHeader().getByText("1", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Show \d+ more$/ }).elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Project sessions are in Code" }));
    await expect
      .element(screen.getByRole("button", { name: "Code", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 1", { exact: true })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Project sessions are in Code" }).elements(),
    ).toHaveLength(0);
    // Code with no project chosen counts and pages only project sessions, not the chats.
    await expect.element(settledHeader().getByText("37", { exact: true })).toBeVisible();
    expect(
      vi
        .mocked(shelfHooks.useOlderSettledShelf)
        .mock.lastCall![0].scopes.map((scope) => scope.projectIds),
    ).toEqual([[app.id]]);
  });

  it("Chat has no pointer to Code without project sessions", async () => {
    using _setup = setup({ threads: [scratchChat], route: null }).stack;
    await using screen = await renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Chat", exact: true }));

    await expect.element(screen.getByText("Scratch chat", { exact: true })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Project sessions are in Code" }).elements(),
    ).toHaveLength(0);
  });

  it("follows the route to the tab of the open thread", async () => {
    using _setup = setup({
      threads: [scratchChat, appThread],
      route: { environmentId: scratchChat.environmentId, threadId: scratchChat.id },
    }).stack;
    await using screen = await renderSidebar();

    await expect
      .element(screen.getByRole("button", { name: "Chat", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Scratch chat", { exact: true })).toBeVisible();
  });

  it("follows an open draft to its project's tab", async () => {
    // A tab left on Chat must not sit beside a project draft, as on the landing page.
    setSidebarTab("chat");
    using _setup = setup({ threads: [scratchChat, appThread], route: null, draftIn: app }).stack;
    await using screen = await renderSidebar();
    await expect
      .element(screen.getByRole("button", { name: "Code", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 1", { exact: true })).toBeVisible();
  });

  it("follows an open chat draft to Chat", async () => {
    using _setup = setup({
      threads: [scratchChat, appThread],
      route: null,
      draftIn: scratch,
    }).stack;
    await using screen = await renderSidebar();
    await expect
      .element(screen.getByRole("button", { name: "Chat", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("Chat from a project draft starts a chat, and Code keeps the project draft", async () => {
    const { stack, startScratchThread, handleNewThread } = setup({
      threads: [appThread],
      route: null,
      draftIn: app,
    });
    using _setup = stack;
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Thread 1", { exact: true })).toBeVisible();
    const navigate = vi.spyOn(screen.router!, "navigate");

    await userEvent.click(screen.getByRole("button", { name: "Chat", exact: true }));
    expect(startScratchThread).toHaveBeenCalledExactlyOnceWith(scratch.environmentId);

    // The chat did not open, so the project draft is still in the main pane.
    await userEvent.click(screen.getByRole("button", { name: "Code", exact: true }));
    await expect
      .element(screen.getByRole("button", { name: "Code", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a thread whose project is unknown stays under Code", async () => {
    const orphan = threadShell(ProjectId.make("not-loaded"), 2);
    using _setup = setup({
      threads: [scratchChat, orphan],
      route: { environmentId: orphan.environmentId, threadId: orphan.id },
    }).stack;
    await using screen = await renderSidebar();

    await expect
      .element(screen.getByRole("button", { name: "Code", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("a remembered chat that was archived is not reopened", async () => {
    const archived = { ...scratchChat, archivedAt: "2026-01-02T00:00:00.000Z" };
    rememberSidebarTabThread("chat", {
      environmentId: archived.environmentId,
      threadId: archived.id,
    });
    const { stack, startScratchThread } = setup({
      threads: [archived, appThread],
      route: { environmentId: appThread.environmentId, threadId: appThread.id },
    });
    using _setup = stack;
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Thread 1", { exact: true })).toBeVisible();
    const navigate = vi.spyOn(screen.router!, "navigate");

    await userEvent.click(screen.getByRole("button", { name: "Chat", exact: true }));
    expect(startScratchThread).toHaveBeenCalledExactlyOnceWith(scratch.environmentId);
    expect(navigate).not.toHaveBeenCalled();
  });
});
