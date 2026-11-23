import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "./ProviderModelPicker";

const pickerEnvironmentId = EnvironmentId.make("picker-test");
const decodePickerConfig = Schema.decodeUnknownSync(ServerConfig);

function pickerRegistry(showOtherAgents: boolean, allowedDrivers: readonly string[] | undefined) {
  const config = decodePickerConfig({
    environment: {
      environmentId: pickerEnvironmentId,
      label: "Desk",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      orchestrationProtocolVersion: 2,
      capabilities: {},
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
    cwd: "/workspace",
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { showOtherAgents },
    ...(allowedDrivers === undefined
      ? {}
      : {
          managedPolicy: {
            organization: "Example Corp",
            lockedSettings: [],
            limits: { providers: { allowedDrivers } },
          },
        }),
  });
  return AtomRegistry.make({
    initialValues: [
      [serverEnvironment.configValueAtom(pickerEnvironmentId), config, { skipInitialRun: true }],
    ],
  });
}

it.each([
  { profile: "fresh", showOtherAgents: false, expected: ["Claude", "Codex"] },
  {
    profile: "opted in",
    showOtherAgents: true,
    expected: ["Claude", "Codex", "Existing Work Agent"],
  },
  {
    profile: "managed",
    showOtherAgents: true,
    policyAllows: ["cursor"],
    expected: ["Existing Work Agent"],
  },
  {
    profile: "locked to a hidden agent",
    showOtherAgents: false,
    locked: true,
    expected: ["Existing Work Agent"],
  },
])(
  "lists models from the right agents in a $profile profile",
  async ({ showOtherAgents, policyAllows, locked, expected }) => {
    using cleanup = new DisposableStack();
    const registry = cleanup.adopt(pickerRegistry(showOtherAgents, policyAllows), (registry) =>
      registry.dispose(),
    );
    cleanup.defer(registry.mount(serverEnvironment.configValueAtom(pickerEnvironmentId)));
    const entries = deriveProviderInstanceEntries(
      ["claudeAgent", "codex", "opencode", "cursor"].map((driver) => ({
        instanceId: ProviderInstanceId.make(driver),
        driver: ProviderDriverKind.make(driver),
        ...(driver === "cursor" ? { displayName: "Existing Work Agent" } : {}),
        enabled: driver !== "opencode",
        installed: driver !== "opencode",
        status: driver === "opencode" ? "disabled" : "ready",
        version: null,
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models:
          driver === "opencode"
            ? []
            : [{ slug: "model", name: `${driver} model`, isCustom: false, capabilities: {} }],
        slashCommands: [],
        skills: [],
      })),
    );
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProviderModelPicker
          environmentId={pickerEnvironmentId}
          activeInstanceId={ProviderInstanceId.make(locked ? "cursor" : "codex")}
          model="model"
          lockedProvider={locked ? ProviderDriverKind.make("cursor") : null}
          instanceEntries={entries}
          modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
          onInstanceModelChange={vi.fn()}
        />
      </RegistryContext.Provider>,
    );
    await screen
      .getByRole("button", { name: locked ? "cursor model" : "codex model", exact: true })
      .click();
    // Every agent's model has the same id here, so they are one row that offers each when pointed at.
    await page.getByRole("option").first().hover();
    await vi.waitFor(() => {
      const choices = [...document.querySelectorAll<HTMLElement>("[data-model-source-choice]")].map(
        (source) => source.dataset.modelSourceChoice,
      );
      const sources = [...document.querySelectorAll<HTMLElement>("[data-model-source]")].map(
        (source) => source.dataset.modelSource,
      );
      expect(choices.length > 0 ? choices : sources).toEqual(expected);
    });
  },
);

it("keeps each registry image when adding a model from another ACP agent", async () => {
  using cleanup = new DisposableStack();
  const registry = cleanup.adopt(pickerRegistry(true, undefined), (registry) => registry.dispose());
  cleanup.defer(registry.mount(serverEnvironment.configValueAtom(pickerEnvironmentId)));
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={pickerEnvironmentId}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Picker />
    </RegistryContext.Provider>,
  );
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("lists a model reported twice by one provider once, with contiguous jump shortcuts", async () => {
  const instanceId = ProviderInstanceId.make("claude");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      ["a", "b", "c", "c", "d", "d"].map((slug) => ({
        slug,
        name: `Model ${slug.toUpperCase()}`,
      })),
    ],
  ]);
  const keybindings = compileResolvedKeybindingsConfig(
    ([1, 2, 3, 4, 5, 6] as const).map((index) => ({
      key: `mod+${index}`,
      command: `modelPicker.jump.${index}` as const,
      when: "modelPickerOpen",
    })),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model="a"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      keybindings={keybindings}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Model A/ })).toBeVisible();
  await vi.waitFor(() =>
    expect(
      page
        .getByRole("option")
        .elements()
        .map((row) => [
          row.textContent?.match(/Model [A-Z]/)?.[0],
          row.querySelector("kbd")?.textContent?.slice(-1),
        ]),
    ).toEqual([
      ["Model A", "1"],
      ["Model B", "2"],
      ["Model C", "3"],
      ["Model D", "4"],
    ]),
  );
});

it("lists a gateway's model once and offers each agent that runs it when pointed at", async () => {
  const gatewayCodex = ProviderInstanceId.make("gw-abc-codex");
  const gatewayOpencode = ProviderInstanceId.make("gw-abc-opencode");
  const entries = deriveProviderInstanceEntries(
    [
      { instanceId: ProviderInstanceId.make("codex"), driver: "codex", displayName: "Codex" },
      { instanceId: gatewayCodex, driver: "codex", displayName: "Codex · Work GW" },
      { instanceId: gatewayOpencode, driver: "opencode", displayName: "opencode · Work GW" },
    ].map((provider) => ({
      ...provider,
      driver: ProviderDriverKind.make(provider.driver),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    })),
  );
  const gatewayModels = [{ slug: "chat-small", name: "chat-small" }];
  const onInstanceModelChange = vi.fn();
  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={ProviderInstanceId.make("codex")}
      model="gpt"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={
        new Map([
          [ProviderInstanceId.make("codex"), [{ slug: "gpt", name: "GPT" }]],
          [gatewayCodex, gatewayModels],
          [gatewayOpencode, gatewayModels],
        ])
      }
      triggerAriaLabel="Choose model"
      onInstanceModelChange={onInstanceModelChange}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /chat-small/ })).toBeVisible();
  const sources = () =>
    [...document.querySelectorAll<HTMLElement>("[data-model-source]")].map(
      (source) => source.dataset.modelSource,
    );
  expect(sources()).toEqual(["Codex", "Work GW · Codex"]);

  // Pointing at the model offers each agent that runs it.
  await page.getByRole("option", { name: /chat-small/ }).hover();
  const choice = document.querySelector<HTMLElement>(
    '[data-model-source-choice="Work GW · opencode"]',
  )!;
  await page.elementLocator(choice).click();
  expect(onInstanceModelChange).toHaveBeenLastCalledWith(gatewayOpencode, "chat-small");
});
