import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Its own file: the shell a file's first test loads stays, and this test needs the scratch project in it.
it("a chat shows the conversation only, a project session shows its panels", async () => {
  await page.viewport(1920, 1000);
  const scratchProjectId = ProjectId.make("project-scratch");
  const chatThread = {
    ...threadWithHistory("scratch-chat-panels", 1),
    projectId: scratchProjectId,
  };
  const codeThread = threadWithHistory("code-session-panels", 1);
  using _environment = installFakeEnvironment([chatThread, codeThread], {
    extraProjects: [{ id: scratchProjectId, title: "scratch" }],
    scratchWorkspaceRoot: "/workspace/scratch",
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${chatThread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByRole("textbox", { name: `Message ${chatThread.title}` });
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  const terminalToggle = page.getByRole("button", { name: "Toggle terminal drawer" });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const panel = page.getByRole("region", { name: /^Workspace panel/ });
  await expect.element(composer).toBeVisible();
  for (const hidden of [toggle, terminalToggle]) {
    await expect.element(hidden).not.toBeInTheDocument();
  }
  await userEvent.click(composer);
  await userEvent.keyboard("{ControlOrMeta>}j{/ControlOrMeta}");
  await userEvent.keyboard("{ControlOrMeta>}d{/ControlOrMeta}");
  await userEvent.keyboard("{ControlOrMeta>}{Alt>}b{/Alt}{/ControlOrMeta}");
  for (const hidden of [panel, terminal, toggle, terminalToggle]) {
    await expect.element(hidden).not.toBeInTheDocument();
  }

  // AgentD's background tasks stay reachable from a chat.
  await act(() =>
    useRightPanelStore
      .getState()
      .open(scopeThreadRef(ENVIRONMENT_ID, chatThread.id), "background-tasks"),
  );
  await expect
    .element(page.getByRole("region", { name: /^Workspace panel: Background tasks/ }))
    .toBeVisible();

  // So does a file one of its links opens.
  await act(() =>
    useRightPanelStore
      .getState()
      .openFile(scopeThreadRef(ENVIRONMENT_ID, chatThread.id), "poster.png"),
  );
  await expect
    .element(page.getByRole("region", { name: /^Workspace panel: poster\.png/ }))
    .toBeVisible();

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: codeThread.id },
    }),
  );
  await expect.element(toggle).toBeVisible();
  await expect.element(terminalToggle).toBeVisible();
  await userEvent.click(page.getByRole("textbox", { name: `Message ${codeThread.title}` }));
  await userEvent.keyboard("{ControlOrMeta>}j{/ControlOrMeta}");
  await expect.element(terminal).toBeVisible();
});
