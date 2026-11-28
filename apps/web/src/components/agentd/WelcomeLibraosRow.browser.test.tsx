import { RegistryContext } from "@effect/atom-react";
import {
  LIBRAOS_GATEWAY_INSTANCE_IDS,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type LibraosGatewayCredits,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const read = { error: null as string | null, isPending: false, refresh: () => {} };
const state = vi.hoisted(() => ({
  gateway: null as unknown,
  credits: null as unknown,
  providersAtom: null as unknown,
  start: vi.fn(),
  refreshStatus: vi.fn(),
  canBuy: true,
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosGateway: () => state.gateway,
  useLibraosCredits: () => state.credits,
  useLibraosSignIn: () => ({ canChange: true, start: state.start }),
  useBuyLibraosCredits: () => ({ canBuy: state.canBuy }),
}));
vi.mock("./LibraosCredits", () => ({
  BuyLibraosCreditsButton: () => <button type="button">Buy credits</button>,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providersAtom = providers;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providers,
      configValueAtom: () => Atom.make(null),
    },
  } as typeof actual;
});

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WelcomeLibraosRow } from "./WelcomeLibraosRow";

const environmentId = "env-1" as EnvironmentId;
const balance = (availableUsd: number): LibraosGatewayCredits => ({
  availableUsd,
  heldUsd: 0,
  enforced: true,
  amountsUsd: [10],
  creditsUrl: "https://console.libraos.com/credits",
  plan: null,
});
const agent = (instanceId: string, driver: string, displayName: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-28T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
const gatewayPi = agent(LIBRAOS_GATEWAY_INSTANCE_IDS.pi, "pi", "Pi · LibraOS");

type Status = { connected: boolean; refusal: string | null } | "checking" | "failed";

const mount = (
  status: Status,
  credits: LibraosGatewayCredits | null = null,
  providers: ServerProvider[] = [],
) => {
  state.gateway =
    status === "checking"
      ? { ...read, data: null, isSuccess: false }
      : status === "failed"
        ? {
            ...read,
            data: null,
            isSuccess: false,
            error: "The environment request failed.",
            refresh: state.refreshStatus,
          }
        : { ...read, data: status, isSuccess: true };
  state.credits = { ...read, data: credits, isSuccess: credits !== null };
  appAtomRegistry.set(
    state.providersAtom as Atom.Writable<ReadonlyArray<ServerProvider>>,
    providers,
  );
  state.start.mockClear();
  state.refreshStatus.mockClear();
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ul>
        <WelcomeLibraosRow
          environmentId={environmentId}
          gatewayLink={<a href="/welcome?screen=gateway" />}
        />
      </ul>
    </RegistryContext.Provider>,
  );
};

it("signed out, offers models without an agent to install and Sign in starts the sign-in", async () => {
  await using _screen = await mount({ connected: false, refusal: null });
  await expect
    .element(
      page.getByText("No agent to install. Use models through LibraOS Gateway, pay as you go."),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Sign in: LibraOS" }).click();
  expect(state.start).toHaveBeenCalledOnce();
  await expect.element(page.getByText(/trial|every model/i)).not.toBeInTheDocument();
});

it("says agents already in use keep their own billing", async () => {
  await using _screen = await mount({ connected: false, refusal: null }, null, [
    agent("claudeAgent", "claudeAgent", "Claude Code"),
  ]);
  await expect
    .element(page.getByText("Agents you already use keep their own sign-in and billing."))
    .toBeVisible();
});

it("is checking until the status is in, and offers Retry when it cannot be read", async () => {
  {
    await using _screen = await mount("checking");
    await expect.element(page.getByText("Checking connection…")).toBeVisible();
    expect(page.getByRole("button").all()).toHaveLength(0);
  }
  await using _screen = await mount("failed");
  await expect.element(page.getByText("The environment request failed.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(state.refreshStatus).toHaveBeenCalledOnce();
});

it("does not call a key the Gateway rejects connected, and offers Reconnect, not credits", async () => {
  await using _screen = await mount({ connected: true, refusal: "Invalid API key" }, balance(5));
  await expect.element(page.getByText("LibraOS Gateway rejected this key")).toBeVisible();
  await expect.element(page.getByText(/Connected/)).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("link", { name: "Reconnect: LibraOS" }))
    .toHaveAttribute("href", "/welcome?screen=gateway");
  expect(page.getByRole("button", { name: "Buy credits" }).all()).toHaveLength(0);
});

it("connected, says the Gateway's Pi is ready with nothing to install, and the balance", async () => {
  await using _screen = await mount({ connected: true, refusal: null }, balance(12.34), [
    gatewayPi,
  ]);
  await expect.element(page.getByText("Pi · LibraOS ready, nothing to install")).toBeVisible();
  await expect.element(page.getByText("$12.34 available")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Manage: LibraOS" }))
    .toHaveAttribute("href", "/welcome?screen=gateway");
});

it("at zero says the credits are used up, with Buy credits for the owner", async () => {
  {
    await using _screen = await mount({ connected: true, refusal: null }, balance(0), [gatewayPi]);
    await expect
      .element(page.getByText("Credits used up. Buy credits to use LibraOS Gateway."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Buy credits" })).toBeVisible();
  }
  state.canBuy = false;
  await using _screen = await mount({ connected: true, refusal: null }, balance(0));
  expect(page.getByRole("button", { name: "Buy credits" }).all()).toHaveLength(0);
  state.canBuy = true;
});

it("connected with no balance from Console, says only that it is connected", async () => {
  await using _screen = await mount({ connected: true, refusal: null }, null);
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
});
