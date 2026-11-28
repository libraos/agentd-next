import type { EnvironmentId, LibraosGatewayCredits, LibraosGatewayPlans } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  gateway: {
    environmentId: "env-1",
    data: { connected: true, refusal: null } as {
      connected: boolean;
      refusal: string | null;
    } | null,
    error: null as string | null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  },
  start: vi.fn(),
  credits: {
    environmentId: "env-1",
    connected: true,
    data: null as LibraosGatewayCredits | null,
    error: null as string | null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  },
  plans: {
    environmentId: "env-1",
    connected: true,
    data: null as LibraosGatewayPlans | null,
    error: null as string | null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  },
  buy: vi.fn((_usd: number) => Promise.resolve()),
  subscribe: vi.fn((_plan: string) => Promise.resolve()),
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosGateway: () => state.gateway,
  useLibraosSignIn: () => ({ canChange: true, start: state.start }),
  useLibraosCredits: () => state.credits,
  useLibraosPlans: () => state.plans,
  useBuyLibraosCredits: () => ({
    canBuy: true,
    buy: state.buy,
    buying: null,
    error: null,
    opened: null,
  }),
  useSubscribeLibraosPlan: () => ({
    canSubscribe: true,
    subscribe: state.subscribe,
    subscribing: null,
    error: null,
    opened: null,
  }),
}));

import { LibraosAccountCard } from "./LibraosAccountCard";

const environmentId = "env-1" as EnvironmentId;
const balance = (overrides: Partial<LibraosGatewayCredits> = {}): LibraosGatewayCredits => ({
  availableUsd: 12.34,
  heldUsd: 0,
  enforced: true,
  amountsUsd: [10, 20, 50],
  creditsUrl: "https://console.libraos.com/credits",
  plan: null,
  ...overrides,
});
const plansBody: LibraosGatewayPlans = {
  plans: [
    {
      id: "pro",
      name: "Pro",
      priceUsd: 20,
      interval: "month",
      summary: "For one person.",
      state: "available",
    },
  ],
  current: null,
  manageUrl: "https://console.libraos.com/plans",
};

function setup(
  connected: boolean,
  credits: LibraosGatewayCredits | null,
  plans: LibraosGatewayPlans | null = plansBody,
  refusal: string | null = null,
) {
  state.gateway = { ...state.gateway, data: { connected, refusal } };
  state.credits = { ...state.credits, connected, data: credits, error: null, isSuccess: true };
  state.plans = {
    ...state.plans,
    connected,
    data: connected ? plans : null,
    error: null,
    isSuccess: true,
  };
  state.buy.mockClear();
  state.subscribe.mockClear();
  state.start.mockClear();
  state.credits.refresh.mockClear();
  state.plans.refresh.mockClear();
}

it("shows the balance and plan on one line, with Buy credits and Plans opening their lists", async () => {
  setup(true, balance());
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText("$12.34 available · No plan")).toBeVisible();
  // Nothing to buy or subscribe to is shown until its button is pressed.
  expect(screen.getByRole("button", { name: /Buy \$/ }).all()).toHaveLength(0);
  expect(screen.getByRole("button", { name: /^Subscribe/ }).all()).toHaveLength(0);

  await screen.getByRole("button", { name: "Buy credits" }).click();
  await page.getByRole("button", { name: "Buy $20" }).click();
  expect(state.buy).toHaveBeenCalledExactlyOnceWith(20);
  await userEvent.keyboard("{Escape}");

  await screen.getByRole("button", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Subscribe to Pro" }).click();
  expect(state.subscribe).toHaveBeenCalledExactlyOnceWith("pro");
});

it("names the account's plan", async () => {
  setup(true, balance({ plan: { name: "Pro", overage: false } }));
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText("$12.34 available · Plan: Pro")).toBeVisible();
});

it("signed out, is one line and Sign in starts the sign-in", async () => {
  setup(false, null);
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect
    .element(screen.getByText("Use models through LibraOS Gateway, pay as you go."))
    .toBeVisible();
  await screen.getByRole("button", { name: "Sign in" }).click();
  expect(state.start).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Buy credits" }).all()).toHaveLength(0);
});

it("with a key the Gateway rejects, says so and offers Reconnect, not Buy credits", async () => {
  setup(true, balance(), plansBody, "Invalid API key");
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText("LibraOS Gateway rejected this key")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Reconnect" }))
    .toHaveAttribute("href", "/settings/providers?setupEndpoint=gateway");
  expect(screen.getByRole("button", { name: "Buy credits" }).all()).toHaveLength(0);
  expect(screen.getByText(/available/).all()).toHaveLength(0);
});

it("at zero says the credits are used up, with Buy credits", async () => {
  setup(true, balance({ availableUsd: 0 }));
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect
    .element(screen.getByText("Credits used up. Buy credits to use LibraOS Gateway. · No plan"))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Buy credits" })).toBeVisible();
});

it("says what it is still reading, and offers Retry for a read that failed", async () => {
  setup(true, null, null);
  state.credits = { ...state.credits, isSuccess: false };
  state.plans = { ...state.plans, isSuccess: false };
  {
    await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
    await expect.element(screen.getByText("Reading balance… · Reading plan…")).toBeVisible();
    expect(screen.getByText(/No plan/).all()).toHaveLength(0);
  }
  state.credits = { ...state.credits, error: "Couldn't reach LibraOS." };
  state.plans = { ...state.plans, error: "Couldn't reach LibraOS." };
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText(/Balance unavailable · Plan unavailable/)).toBeVisible();
  await screen.getByRole("button", { name: "Retry" }).click();
  expect(state.credits.refresh).toHaveBeenCalledOnce();
  expect(state.plans.refresh).toHaveBeenCalledOnce();
});

it("is checking until the status is in, and the Plans popover says when none are on offer", async () => {
  setup(true, balance(), { ...plansBody, plans: [] });
  state.gateway = { ...state.gateway, data: null, isSuccess: false };
  {
    await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
    await expect.element(screen.getByText("Checking connection…")).toBeVisible();
  }
  state.gateway = { ...state.gateway, data: { connected: true, refusal: null }, isSuccess: true };
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await screen.getByRole("button", { name: "Plans" }).click();
  await expect.element(page.getByText("No plans on offer right now.")).toBeVisible();
});
