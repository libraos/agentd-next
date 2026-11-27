import type { EnvironmentId, LibraosGatewayPlans } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  plans: {
    environmentId: "env-1",
    connected: true,
    data: null as LibraosGatewayPlans | null,
    error: null as string | null,
    isPending: false,
    refresh: () => {},
  },
  subscribing: {
    canSubscribe: true,
    subscribe: (_plan: string) => Promise.resolve(),
    subscribing: null as string | null,
    error: null as string | null,
    opened: null as string | null,
  },
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosPlans: () => state.plans,
  useSubscribeLibraosPlan: () => state.subscribing,
}));

import { LibraosPlansPanel } from "./LibraosPlans";

const environmentId = "env-1" as EnvironmentId;
const MANAGE_URL = "https://console.libraos.com/plans?ws=acme";
const offered = (overrides: Partial<LibraosGatewayPlans> = {}): LibraosGatewayPlans => ({
  plans: [
    {
      id: "personal",
      name: "Personal",
      priceUsd: 20,
      interval: "month",
      summary: "For one person.",
      state: "available",
    },
    {
      id: "pro",
      name: "Pro",
      priceUsd: 480,
      interval: "year",
      summary: "More tokens for long runs.",
      state: "available",
    },
    {
      id: "team",
      name: "Team",
      priceUsd: 50,
      interval: "month",
      summary: "Shared credit.",
      state: "coming_soon",
    },
    {
      id: "old",
      name: "Legacy",
      priceUsd: 5,
      interval: "month",
      summary: "",
      state: "unavailable",
    },
  ],
  current: null,
  manageUrl: MANAGE_URL,
  ...overrides,
});

function setup(
  plans: Partial<typeof state.plans>,
  subscribing: Partial<typeof state.subscribing> = {},
) {
  const subscribe = vi.fn((_plan: string) => Promise.resolve());
  state.plans = { ...state.plans, data: null, error: null, isPending: false, ...plans };
  state.subscribing = {
    canSubscribe: true,
    subscribe,
    subscribing: null,
    error: null,
    opened: null,
    ...subscribing,
  };
  return subscribe;
}

const card = (name: string) => page.getByRole("listitem", { name });

it("with no plans from Console shows only a See plans link, and no error", async () => {
  setup({ data: null });
  await using screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  const link = page.getByRole("link", { name: "See plans" });
  await expect.element(link).toHaveAttribute("href", "https://console.libraos.com/credits");
  expect(screen.container.textContent).toBe("See plans");
});

it("shows a card per plan with Console's name, price and summary, and subscribes to one", async () => {
  const subscribe = setup({ data: offered() });
  await using screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect.element(card("Personal").getByText("$20 per month")).toBeVisible();
  await expect.element(card("Personal").getByText("For one person.")).toBeVisible();
  await expect.element(card("Pro").getByText("$480 per year")).toBeVisible();
  await expect.element(card("Team").getByText("Coming soon")).toBeVisible();
  expect(card("Team").getByRole("button").elements()).toHaveLength(0);
  expect(card("Legacy").getByRole("button").elements()).toHaveLength(0);
  expect(screen.container.querySelectorAll("a, button")).toHaveLength(2);
  await expect.element(page.getByRole("link", { name: "Manage plan" })).not.toBeInTheDocument();
  await card("Pro").getByRole("button", { name: "Subscribe" }).click();
  expect(subscribe).toHaveBeenCalledExactlyOnceWith("pro");
});

it("marks the current plan and links Console to manage it", async () => {
  const data = offered({ current: "personal" });
  setup({
    data: {
      ...data,
      plans: data.plans.map((plan) =>
        plan.id === "personal" ? { ...plan, state: "current" as const } : plan,
      ),
    },
  });
  await using _screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect.element(card("Personal").getByText("Current plan")).toBeVisible();
  expect(card("Personal").getByRole("button").elements()).toHaveLength(0);
  await expect
    .element(page.getByRole("link", { name: "Manage plan" }))
    .toHaveAttribute("href", MANAGE_URL);
});

it("says where to finish subscribing once the checkout is open", async () => {
  const url = "https://checkout.stripe.com/c/pay/cs_test_plan";
  setup({ data: offered() }, { opened: url });
  await using _screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect.element(page.getByText(/Finish subscribing in your browser/)).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open the checkout page" }))
    .toHaveAttribute("href", url);
});

it("shows a refused checkout with Console's plans page beside it", async () => {
  setup(
    { data: offered() },
    { error: "LibraOS could not start a checkout: You already have an active plan." },
  );
  await using _screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect
    .element(page.getByText(/could not start a checkout: You already have/))
    .toBeVisible();
  await expect
    .element(page.getByRole("alert").getByRole("link", { name: "See plans" }))
    .toHaveAttribute("href", MANAGE_URL);
});

it("shows the plan being opened and holds the other Subscribe buttons", async () => {
  setup({ data: offered() }, { subscribing: "pro" });
  await using _screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect
    .element(card("Pro").getByRole("button", { name: "Opening checkout…" }))
    .toBeDisabled();
  await expect.element(card("Personal").getByRole("button", { name: "Subscribe" })).toBeDisabled();
});

it("cannot subscribe without permission to change this environment", async () => {
  setup({ data: offered() }, { canSubscribe: false });
  await using _screen = await render(<LibraosPlansPanel environmentId={environmentId} />);
  await expect.element(card("Personal").getByRole("button", { name: "Subscribe" })).toBeDisabled();
});
