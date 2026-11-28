import type { EnvironmentId, LibraosGatewayCredits, LibraosGatewayPlans } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  credits: {
    environmentId: "env-1",
    connected: true,
    data: null as LibraosGatewayCredits | null,
    error: null as string | null,
    isPending: false,
    refresh: () => {},
  },
  plans: {
    environmentId: "env-1",
    connected: true,
    data: null as LibraosGatewayPlans | null,
    error: null as string | null,
    isPending: false,
    refresh: () => {},
  },
  buy: vi.fn((_usd: number) => Promise.resolve()),
  subscribe: vi.fn((_plan: string) => Promise.resolve()),
}));

vi.mock("../../lib/libraosGatewayState", () => ({
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

function setup(connected: boolean, credits: LibraosGatewayCredits | null, plans = plansBody) {
  state.credits = { ...state.credits, connected, data: credits };
  state.plans = { ...state.plans, connected, data: connected ? plans : null };
  state.buy.mockClear();
  state.subscribe.mockClear();
}

it("shows the balance and plan on one line, with Buy credits and Plans opening their lists", async () => {
  setup(true, balance());
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText("$12.34 available · No plan")).toBeVisible();
  // Nothing to buy or subscribe to is shown until its button is pressed.
  expect(screen.getByRole("button", { name: /Buy \$/ }).all()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Subscribe" }).all()).toHaveLength(0);

  await screen.getByRole("button", { name: "Buy credits" }).click();
  await page.getByRole("button", { name: "Buy $20" }).click();
  expect(state.buy).toHaveBeenCalledExactlyOnceWith(20);
  await userEvent.keyboard("{Escape}");

  await screen.getByRole("button", { name: "Plans" }).click();
  await page.getByRole("button", { name: "Subscribe" }).click();
  expect(state.subscribe).toHaveBeenCalledExactlyOnceWith("pro");
});

it("names the account's plan", async () => {
  setup(true, balance({ plan: { name: "Pro", overage: false } }));
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect.element(screen.getByText("$12.34 available · Plan: Pro")).toBeVisible();
});

it("signed out, is one line and Sign in to the Gateway screen", async () => {
  setup(false, null);
  await using screen = await render(<LibraosAccountCard environmentId={environmentId} />);
  await expect
    .element(screen.getByText("Every model on one account, pay as you go."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Sign in" }))
    .toHaveAttribute("href", "/settings/providers?setupEndpoint=gateway");
  expect(screen.getByRole("button", { name: "Buy credits" }).all()).toHaveLength(0);
});
