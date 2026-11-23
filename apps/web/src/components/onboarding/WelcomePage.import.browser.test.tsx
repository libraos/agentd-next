import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  candidates: null as unknown,
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  scanError: null as string | null,
  scanPending: false,
  runningTerminalIds: null as unknown,
  openTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  closeTerminal: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as never,
  };
});
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: "primary", label: "primary" }],
  })) as never,
  usePrimaryEnvironmentId: (() => "primary") as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refreshProviders" as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjects: (() => useAtomValue(state.projects as Atom.Atom<Project[]>)) as never,
    readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
    waitForProject: ((ref: unknown) => state.waitForProject(ref)) as never,
  };
});
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjectScans: (ids: readonly EnvironmentId[]) => {
      const candidates = useAtomValue(
        state.candidates as Atom.Atom<AgentSessionProjectCandidate[]>,
      );
      return ids.map((environmentId) => {
        state.scan({ environmentId });
        return {
          environmentId,
          data: (state.scanPending ? null : { candidates, truncated: false }) as never,
          isPending: state.scanPending,
          error: state.scanError,
          refresh: state.refreshScan,
        };
      });
    },
  };
});
vi.mock(import("../../state/terminal"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    terminalEnvironment: {
      ...actual.terminalEnvironment,
      open: "openTerminal",
      write: "writeTerminal",
      close: "closeTerminal",
    } as never,
  };
});
vi.mock(import("../../state/terminalSessions"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useThreadRunningTerminalIds: (() =>
      useAtomValue(state.runningTerminalIds as Atom.Atom<ReadonlyArray<string>>)) as never,
  };
});
vi.mock(import("../ThreadTerminalDrawer"), async (original) => ({
  ...(await original()),
  TerminalViewport: () => <div />,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((
    command:
      | "createProject"
      | "importThreads"
      | "refreshProviders"
      | "openTerminal"
      | "writeTerminal"
      | "closeTerminal",
  ) => state[command]) as never,
}));

import { welcomeImportSelectionKey } from "../../onboarding/welcomeState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { WelcomePage } from "./WelcomePage";

const primaryId = EnvironmentId.make("primary");
const readyClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const openCode = {
  ...readyClaude,
  instanceId: ProviderInstanceId.make("opencode"),
  driver: ProviderDriverKind.make("opencode"),
};
const permissionMessage = "This connection cannot import projects or thread history.";

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
}

function sessionAtom(environmentId: EnvironmentId) {
  return state.sessions.get(environmentId) as Atom.Writable<SessionResult>;
}

function projectsAtom() {
  return state.projects as Atom.Writable<ReadonlyArray<Project>>;
}

function candidatesAtom() {
  return state.candidates as Atom.Writable<ReadonlyArray<AgentSessionProjectCandidate>>;
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  appAtomRegistry.set(
    sessionAtom(environmentId),
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

// Default selection only picks recently active projects, so pin "now".
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
    ...overrides,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  appAtomRegistry.set(projectsAtom(), [
    ...appAtomRegistry.get(projectsAtom()),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

// Resolves once the project reaches the mocked projects atom; the real helper's timeout is
// replaced per test with a rejection.
function waitForRecordedProject(ref: { environmentId: EnvironmentId; projectId: string }) {
  const find = () =>
    appAtomRegistry
      .get(projectsAtom())
      .find(
        (project) => project.id === ref.projectId && project.environmentId === ref.environmentId,
      );
  return new Promise<Project>((resolve) => {
    const current = find();
    if (current) return resolve(current);
    const unsubscribe = appAtomRegistry.subscribe(projectsAtom(), () => {
      const project = find();
      if (!project) return;
      unsubscribe();
      resolve(project);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pageText() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

// Continue, or "Import N projects and continue" once projects are picked.
function startButton() {
  const found = [...document.querySelectorAll("button")].find((element) =>
    /^(Continue|Import \d+ projects? and continue)$/u.test(element.textContent?.trim() ?? ""),
  );
  if (!found) throw new Error("Missing button: Continue");
  return found;
}

async function start() {
  const target = startButton();
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

// Nothing is imported until the person checks the box, which picks the recent new projects.
async function pickProjects() {
  const importProjects = document.querySelector<HTMLElement>('[role="checkbox"]');
  await act(async () => importProjects?.click());
}

async function mountWelcome() {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomePage environmentId={primaryId} onDone={state.onDone} />
    </RegistryContext.Provider>,
  );
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.sessions.clear();
  for (const id of [primaryId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([readyClaude]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = Atom.make<ReadonlyArray<AgentSessionProjectCandidate>>([
    candidate("/projects/first"),
    candidate("/projects/second"),
  ]).pipe(Atom.keepAlive);
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  state.scanError = null;
  state.scanPending = false;
  state.runningTerminalIds = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive);
  for (const command of [state.openTerminal, state.writeTerminal, state.closeTerminal]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  localStorage.removeItem(welcomeImportSelectionKey(primaryId));
  return now;
}

it("rechecks after project creation and can retry its history without recreating the project", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  await using _screen = await mountWelcome();
  await pickProjects();
  await start();
  expect(state.createProject).toHaveBeenCalledOnce();
  await act(async () => {
    setGrant(primaryId, false);
    creation.resolve();
    await creation.promise;
  });
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(pageText()).toContain(permissionMessage));

  await act(async () => setGrant(primaryId, true));
  // The first project now exists, so only the second counts as new.
  await start();
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.importThreads).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("completes accepted imports when permission is revoked after the final server write", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountWelcome();
  await pickProjects();
  await start();
  await act(async () => {
    setGrant(primaryId, false);
    imported.resolve({ importedCount: 1, skippedCount: 0 });
    await imported.promise;
  });
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.importThreads).toHaveBeenCalledOnce();
  expect(state.completeOnboarding).toHaveBeenCalledOnce();
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("finishes setup without landing when the imported project never reaches the client", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  // The server accepts the project, but it never shows up in the client's projects.
  state.createProject.mockResolvedValue(AsyncResult.success(undefined));
  state.waitForProject.mockRejectedValue(new Error("The project did not appear."));
  state.completeOnboarding.mockRejectedValueOnce(new Error("offline"));
  await using _screen = await mountWelcome();
  using toastAdd = vi.spyOn(toastManager, "add");

  await pickProjects();
  await start();
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  // A failed completion hands the step back instead of leaving it importing.
  await vi.waitFor(() => expect(startButton().disabled).toBe(false));
  expect(state.onDone).not.toHaveBeenCalled();

  await start();
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.onDone).toHaveBeenCalledWith(undefined);
  // The retry skips the project it already imported, but still counts its thread.
  await vi.waitFor(() =>
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Imported 1 thread" }),
    ),
  );
});

it("shows the three agents in order and enables Continue when one is ready", async () => {
  using _now = setup();
  const codex: ServerProvider = {
    ...readyClaude,
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    status: "error",
    auth: { status: "unauthenticated" },
  };
  const missingOpenCode: ServerProvider = {
    ...openCode,
    installed: false,
    status: "error",
    auth: { status: "unknown" },
  };
  const providers = state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>;
  appAtomRegistry.set(providers, [missingOpenCode, codex]);
  await using screen = await mountWelcome();
  const rows = screen.getByRole("region", { name: "Agents" }).getByRole("listitem");
  expect(rows.all()).toHaveLength(3);
  const expected = [
    ["Claude Code", "Checking…"],
    ["Codex", "Needs sign-in"],
    ["opencode", "Not installed"],
  ] as const;
  for (const [index, [name, status]] of expected.entries()) {
    const row = rows.nth(index);
    await expect.element(row.getByText(name, { exact: true })).toBeVisible();
    await expect.element(row.getByText(status, { exact: true })).toBeVisible();
  }
  expect(button("Continue").disabled).toBe(true);

  await act(async () =>
    appAtomRegistry.set(providers, [
      missingOpenCode,
      readyClaude,
      { ...codex, auth: { status: "unknown" }, message: "Could not check this CLI." },
    ]),
  );
  await expect.element(rows.nth(0).getByText("Ready", { exact: true })).toBeVisible();
  await expect.element(rows.nth(1).getByText("Could not check this CLI.")).toBeVisible();
  expect(rows.nth(1).getByRole("button", { name: "Sign in: Codex" }).all()).toHaveLength(1);
  await pickProjects();
  await start();
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("blocks leaving the page until the imported projects have landed", async () => {
  using _now = setup();
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    await creation.promise;
    return recordProject(input);
  });
  const landing = deferred<void>();
  state.waitForProject.mockImplementation(
    async (ref: { environmentId: EnvironmentId; projectId: string }) => {
      await landing.promise;
      return waitForRecordedProject(ref);
    },
  );
  await using screen = await mountWelcome();
  await pickProjects();
  await start();

  // A blocked navigation never settles, so it is not awaited.
  const leave = () =>
    act(async () => {
      void screen.router?.navigate({ to: "/settings" });
    });
  await leave();
  await act(async () => {
    creation.resolve();
    await creation.promise;
  });
  await vi.waitFor(() => expect(state.waitForProject).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await act(async () => {
    landing.resolve();
    await landing.promise;
  });
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  await leave();
  expect(screen.router?.state.location.pathname).toBe("/");

  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(screen.router?.state.location.pathname).toBe("/");
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("imports none by default, and leaves a project a later scan finds unpicked", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  expect(startButton().textContent?.trim()).toBe("Continue");
  await pickProjects();
  await vi.waitFor(() =>
    expect(startButton().textContent?.trim()).toBe("Import 2 projects and continue"),
  );
  // Turning on another agent rescans and finds a recent project the user has not seen.
  await act(async () =>
    appAtomRegistry.set(candidatesAtom(), [
      ...appAtomRegistry.get(candidatesAtom()),
      candidate("/projects/third"),
    ]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Choose from 3 projects"));
  expect(startButton().textContent?.trim()).toBe("Import 2 projects and continue");
});

it("keeps the project choice across a visit to Settings until setup finishes", async () => {
  using _now = setup();
  {
    await using _first = await mountWelcome();
    await pickProjects();
    await vi.waitFor(() => expect(startButton().disabled).toBe(false));
  }
  // Coming back from Settings mounts the page again.
  {
    await using _second = await mountWelcome();
    expect(startButton().textContent?.trim()).toBe("Import 2 projects and continue");
    await start();
    await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
    expect(state.createProject).toHaveBeenCalledTimes(2);
  }
  await using _third = await mountWelcome();
  expect(button("Continue").disabled).toBe(false);
});

it("stays busy while setup saves after an import with nothing to open", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  state.importThreads.mockResolvedValue(AsyncResult.success({ importedCount: 0, skippedCount: 1 }));
  const saved = deferred<void>();
  state.completeOnboarding.mockImplementationOnce(() => saved.promise);
  await using _screen = await mountWelcome();

  await pickProjects();
  await start();
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  expect(button("Importing…").disabled).toBe(true);
  await act(async () => {
    saved.resolve();
    await saved.promise;
  });
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledOnce();
});

it("leaves projects already in AgentD Next out when the box is checked, unless they are all there", async () => {
  using _now = setup();
  const existing = ProjectId.make("existing");
  const justAdded = ProjectId.make("just-added");
  appAtomRegistry.set(projectsAtom(), [
    { id: existing, environmentId: primaryId, workspaceRoot: "/projects/first" },
    // Added a moment ago, so the cached scan does not know it exists yet.
    { id: justAdded, environmentId: primaryId, workspaceRoot: "/projects/second" },
  ]);
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: existing }),
    candidate("/projects/second"),
    candidate("/projects/third"),
  ]);
  {
    await using _screen = await mountWelcome();
    await pickProjects();
    await vi.waitFor(() => expect(pageText()).toContain("Import 1 project and their threads"));
  }

  // With every project already in AgentD Next, checking the box still picks them.
  appAtomRegistry.set(candidatesAtom(), appAtomRegistry.get(candidatesAtom()).slice(0, 2));
  await using _screen = await mountWelcome();
  await pickProjects();
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
  expect(startButton().disabled).toBe(false);
});

it("keeps the started projects checked when the page opens again after a quit", async () => {
  using _now = setup();
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  {
    await using _first = await mountWelcome();
    await pickProjects();
    await start();
    await vi.waitFor(() => expect(state.importThreads).toHaveBeenCalledOnce());
  }
  // The app quit during the first project's history; it now exists in AgentD Next.
  const [first] = appAtomRegistry.get(projectsAtom());
  appAtomRegistry.set(candidatesAtom(), [
    candidate("/projects/first", { alreadyImported: true, projectId: first!.id }),
    candidate("/projects/second"),
  ]);
  await using _second = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Import 2 projects and their threads"));
});

it("keeps the project controls when a later scan fails", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  state.scanError = "The scan timed out.";
  await act(async () =>
    appAtomRegistry.set(candidatesAtom(), [...appAtomRegistry.get(candidatesAtom())]),
  );
  await vi.waitFor(() => expect(pageText()).toContain("Could not check projects again."));
  expect(button("Continue").disabled).toBe(false);
  expect(button("Retry").disabled).toBe(false);
});

it("keeps saved picks when Start comes before the project list loads", async () => {
  using _now = setup();
  const saved = JSON.stringify({ knownKeys: ["a"], keys: ["a"], optedOut: false });
  localStorage.setItem(welcomeImportSelectionKey(primaryId), saved);
  state.scanPending = true;
  await using _screen = await mountWelcome();

  await click("Continue");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  // An import a quit cut short is still checked on the next visit.
  expect(localStorage.getItem(welcomeImportSelectionKey(primaryId))).toBe(saved);
});

it("offers Update for a signed-in agent whose version is broken, and keeps Start off", async () => {
  using _now = setup();
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
    {
      ...readyClaude,
      compatibilityAdvisory: {
        status: "broken",
        message: "Update Claude Code to 2.0 or later.",
        recommendedVersion: "2.0.0",
        recommendedRange: null,
      },
    },
  ]);
  await using _screen = await mountWelcome();
  await vi.waitFor(() => expect(pageText()).toContain("Update Claude Code to 2.0 or later."));
  const update = [...document.querySelectorAll("a")].find(
    (element) => element.textContent?.trim() === "Update",
  );
  expect(update?.getAttribute("href")).toContain("/settings/providers");
  expect(button("Continue").disabled).toBe(true);
});

it("installs and signs in to opencode from its row, rechecking after the install command exits", async () => {
  using _now = setup();
  appAtomRegistry.set(
    sessionAtom(primaryId),
    AsyncResult.success(session([AuthOrchestrationOperateScope, AuthTerminalOperateScope])),
  );
  appAtomRegistry.set(state.config as Atom.Writable<unknown>, {
    cwd: "/Users/dev",
    environment: { platform: { os: "darwin" } },
    keybindings: [],
    settings: { providerInstances: {}, projectSettingsOverrides: {} },
  });
  const providers = state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>;
  appAtomRegistry.set(providers, [
    { ...openCode, installed: false, status: "error", auth: { status: "unknown" } },
  ]);
  await using _screen = await mountWelcome();
  await vi.waitFor(() => button("Install"));
  await click("Install");
  await vi.waitFor(() => expect(state.writeTerminal).toHaveBeenCalledOnce());
  expect(state.writeTerminal.mock.calls[0]![0].input.data).toBe("npm install -g opencode-ai");
  const { terminalId } = state.openTerminal.mock.calls[0]![0].input;
  const runningTerminalIds = state.runningTerminalIds as Atom.Writable<ReadonlyArray<string>>;
  const recheck = { environmentId: primaryId, input: { instanceId: openCode.instanceId } };

  await act(async () => appAtomRegistry.set(runningTerminalIds, [terminalId]));
  expect(state.refreshProviders).not.toHaveBeenCalledWith(recheck);
  // The shell stays open at its prompt after the install, so only the command exits.
  await act(async () => appAtomRegistry.set(runningTerminalIds, []));
  expect(state.refreshProviders).toHaveBeenCalledWith(recheck);
  expect(state.closeTerminal).not.toHaveBeenCalled();

  await act(async () =>
    appAtomRegistry.set(providers, [
      { ...openCode, status: "warning", auth: { status: "unknown" } },
    ]),
  );
  await click("Sign in");
  await vi.waitFor(() => expect(state.writeTerminal).toHaveBeenCalledTimes(2));
  expect(state.writeTerminal.mock.calls[1]![0].input.data).toBe("opencode auth login");
});

it("keeps the project choice on the page when storage cannot save it", async () => {
  using _now = setup();
  await using _screen = await mountWelcome();
  using _full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  await pickProjects();

  await start();
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).toHaveBeenCalledTimes(2);
});

it("keeps other agents behind More agents, even when one of them is ready", async () => {
  using _now = setup();
  const pi = {
    ...readyClaude,
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
  };
  appAtomRegistry.set(state.providers as Atom.Writable<ReadonlyArray<ServerProvider>>, [
    { ...pi, displayName: "Pi" },
  ]);
  await using screen = await mountWelcome();
  const more = screen.getByRole("button", { name: "More agents" });
  await expect.element(more).toHaveAttribute("aria-expanded", "false");
  expect(button("Continue").disabled).toBe(false);
  await more.click();
  await expect.element(screen.getByText("Pi", { exact: true })).toBeVisible();
});

it("lists every endpoint, asks which agents use a gateway, and keeps the Gateway shortcut selected", async () => {
  using _now = setup();
  await using screen = await mountWelcome();
  const firstHeading = screen.getByRole("heading", { name: "Connect an agent you already use" });
  const endpointHeading = screen.getByRole("heading", { name: "Use an API key or gateway" });
  const options = screen.getByRole("list", { name: "Endpoint options" });

  await screen.getByRole("link", { name: "Use an API key or gateway" }).click();
  await expect.element(endpointHeading).toBeVisible();
  await expect.element(options.getByRole("button").first()).toHaveAccessibleName("LibraOS Gateway");
  expect(options.getByRole("button").elements()).toHaveLength(6);
  for (const name of ["LibraOS Gateway", "Custom endpoint"]) {
    await expect.element(options.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  for (const name of ["Anthropic API key", "OpenAI API key", "AWS Bedrock", "Ollama"]) {
    const option = options.getByRole("button", { name, exact: true });
    await expect.element(option).toBeDisabled();
    await expect.element(option).toHaveAccessibleDescription(/Not available yet/);
  }
  await expect
    .element(options.getByRole("button", { name: "LibraOS Gateway" }))
    .toHaveAttribute("aria-pressed", "false");
  await expect.element(options.getByText("Requires a LibraOS account.")).toBeVisible();
  await options.getByRole("button", { name: "Custom endpoint" }).click();
  await expect
    .element(options.getByRole("button", { name: "Custom endpoint" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByLabelText("Key (optional)")).toHaveAttribute("type", "password");
  const agents = screen.getByRole("group", { name: "Which agents should use this gateway?" });
  await expect.element(agents.getByRole("checkbox", { name: "Codex" })).toBeChecked();
  await expect.element(agents.getByRole("checkbox", { name: "opencode" })).toBeChecked();
  await expect.element(agents.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
  await screen.getByRole("radio", { name: "Anthropic" }).click();
  await expect.element(agents.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
  await expect.element(agents.getByRole("checkbox", { name: "Codex" })).toBeDisabled();
  await screen.getByRole("link", { name: "Back" }).click();
  await expect.element(firstHeading).toBeVisible();

  await screen.getByRole("link", { name: "Use a LibraOS account" }).click();
  await expect.element(endpointHeading).toBeVisible();
  await expect
    .element(screen.getByText("LibraOS Gateway selected. Requires a LibraOS account."))
    .toBeVisible();
  await expect
    .element(options.getByRole("button", { name: "LibraOS Gateway" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByLabelText("LibraOS API key"))
    .toHaveAttribute("type", "password");
  await screen.getByRole("link", { name: "Back" }).click();
  await expect.element(firstHeading).toBeVisible();

  await screen.getByRole("link", { name: "Join a team" }).click();
  await expect.element(screen.getByRole("heading", { name: "Join a team" })).toBeVisible();
  await screen.getByRole("link", { name: "Back" }).click();
  await expect.element(firstHeading).toBeVisible();
});

it("starts without importing when this connection cannot import projects", async () => {
  using _now = setup();
  setGrant(primaryId, false);
  await using _screen = await mountWelcome();
  expect(pageText()).not.toContain("Choose from");

  await click("Continue");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  expect(state.createProject).not.toHaveBeenCalled();
});
