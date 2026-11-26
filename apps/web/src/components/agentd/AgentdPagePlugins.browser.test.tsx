import {
  AgentdPluginError,
  type AgentdPluginListing,
  type AgentdPlugins,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { AgentdPagePlugins } from "./AgentdPagePlugins";

const ENVIRONMENT = EnvironmentId.make("environment-1");

const row = (
  overrides: Partial<AgentdPluginListing> & Pick<AgentdPluginListing, "id" | "origin" | "name">,
) =>
  ({
    description: "",
    author: "Acme",
    licence: "MIT",
    version: "1.0.0",
    hooks: ["before-send"],
    enabled: false,
    state: "absent",
    ...overrides,
  }) satisfies AgentdPluginListing;

const state = vi.hoisted(() => ({
  plugins: null as AgentdPlugins | null,
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  // Allowed to change plugins here.
  useAtomValue: (() => true) as never,
}));

vi.mock(import("~/lib/agentdState"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAgentdPlugins: (() => ({
      data: state.plugins,
      error: null,
      refresh: () => {},
    })) as unknown as typeof actual.useAgentdPlugins,
    useAgentdPluginCommands: (() =>
      state.commands) as unknown as typeof actual.useAgentdPluginCommands,
  };
});

function listing(developerMode: boolean): AgentdPlugins {
  return {
    source: "cache",
    sources: [
      { repository: "libraos/plugins", official: true, hasToken: false, state: "cache" },
      { repository: "acme/private", official: false, hasToken: true, state: "cache" },
    ],
    developerMode,
    beforeSend: false,
    plugins: [
      row({ id: "pass", origin: { kind: "official" }, name: "Pass" }),
      row({
        id: "gh~acme~private~pass",
        origin: { kind: "github", repository: "acme/private" },
        name: "Acme pass",
      }),
      ...(developerMode
        ? [
            row({
              id: "local~devtool",
              origin: { kind: "local", path: "/home/me/devtool" },
              name: "Dev tool",
              installedVersion: "1.0.0",
              state: "off",
              problems: ["version: is missing"],
            }),
          ]
        : []),
    ],
  };
}

const ok = () => vi.fn().mockResolvedValue({ _tag: "Success", value: {} });

function setup() {
  state.plugins = listing(false);
  state.commands = {
    install: ok(),
    remove: ok(),
    setEnabled: ok(),
    setup: ok(),
    setSettings: ok(),
    addSource: ok(),
    removeSource: ok(),
    setDeveloperMode: ok(),
    addLocal: ok(),
  };
}

it("lists catalogues, adds one with a token and removes it; the official one has no Remove", async () => {
  setup();
  await using _screen = await render(<AgentdPagePlugins environmentId={ENVIRONMENT} />);
  await expect.element(page.getByText("libraos/plugins")).toBeVisible();
  await expect.element(page.getByText("Private, token kept")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove libraos/plugins" }))
    .not.toBeInTheDocument();

  await userEvent.type(page.getByLabelText("Repository"), "other/plugins");
  await userEvent.type(page.getByLabelText("Token (private repositories only)"), "tok-123");
  await expect
    .element(page.getByLabelText("Token (private repositories only)"))
    .toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Add catalogue" }).click();
  expect(state.commands.addSource).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT,
    input: { repository: "other/plugins", token: "tok-123" },
  });
  await expect.element(page.getByLabelText("Token (private repositories only)")).toHaveValue("");

  await page.getByRole("button", { name: "Remove acme/private" }).click();
  await page.getByRole("button", { name: "Remove catalogue" }).click();
  expect(state.commands.removeSource).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT,
    input: { repository: "acme/private" },
  });
});

it("shows where each plugin came from, and the install dialog says it too", async () => {
  setup();
  await using _screen = await render(<AgentdPagePlugins environmentId={ENVIRONMENT} />);
  await expect.element(page.getByText("Official").first()).toBeVisible();
  await expect.element(page.getByText("acme (private)")).toBeVisible();

  await page.getByRole("button", { name: "Install" }).nth(1).click();
  await expect.element(page.getByText("Install Acme pass 1.0.0?")).toBeVisible();
  await expect.element(page.getByText("Source: acme (private)")).toBeVisible();
  await expect.element(page.getByText(/not reviewed by LibraOS/)).toBeVisible();
  expect(state.commands.install).not.toHaveBeenCalled();
  await page.getByRole("alertdialog").getByRole("button", { name: "Install" }).click();
  expect(state.commands.install).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT,
    input: { id: "gh~acme~private~pass" },
  });
});

it("developer mode is off until turned on; a local folder is added, marked Local, and a refusal shown", async () => {
  setup();
  await using screen = await render(<AgentdPagePlugins environmentId={ENVIRONMENT} />);
  await expect.element(page.getByLabelText("Plugin folder (full path)")).not.toBeInTheDocument();
  await page.getByRole("switch", { name: "Developer mode" }).click();
  expect(state.commands.setDeveloperMode).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT,
    input: { enabled: true },
  });

  state.plugins = listing(true);
  state.commands.addLocal = vi.fn().mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(
      new AgentdPluginError({
        reason: "invalid",
        message:
          'agentd-plugin.json in /home/me/bad is refused:\n["surprise"]: Expected no excess property',
      }),
    ),
  });
  await screen.rerender(<AgentdPagePlugins environmentId={ENVIRONMENT} />);
  await expect.element(page.getByText("Local", { exact: true })).toBeVisible();
  await expect.element(page.getByText("/home/me/devtool")).toBeVisible();
  await expect.element(page.getByText("version: is missing")).toBeVisible();

  await userEvent.type(page.getByLabelText("Plugin folder (full path)"), "/home/me/bad");
  await page.getByRole("button", { name: "Add folder" }).click();
  expect(state.commands.addLocal).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT,
    input: { path: "/home/me/bad" },
  });
  await expect.element(page.getByText(/Expected no excess property/)).toBeVisible();
});

it("a plugin whose catalogue was removed stays installed and says its source is gone", async () => {
  setup();
  state.plugins = {
    ...listing(false),
    sources: [{ repository: "libraos/plugins", official: true, hasToken: false, state: "cache" }],
    plugins: [
      row({
        id: "gh~acme~private~pass",
        origin: { kind: "github", repository: "acme/private" },
        name: "Acme pass",
        installedVersion: "1.0.0",
        enabled: true,
        state: "on",
        sourceRemoved: true,
      }),
    ],
  };
  await using _screen = await render(<AgentdPagePlugins environmentId={ENVIRONMENT} />);
  await expect.element(page.getByText("acme (private)")).toBeVisible();
  await expect.element(page.getByText("Source removed")).toBeVisible();
  await expect
    .element(page.getByText(/acme\/private is no longer a catalogue source/))
    .toBeVisible();
  await expect.element(page.getByRole("switch", { name: "Turn Acme pass on" })).toBeChecked();
  await expect.element(page.getByRole("button", { name: "Update" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Remove" })).toBeVisible();
});
