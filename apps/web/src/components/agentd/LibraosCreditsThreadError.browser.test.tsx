import type { EnvironmentId, LibraosGatewayCredits, LibraosGatewayPlans } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosCredits: () => state.credits,
  useBuyLibraosCredits: () => ({
    canBuy: true,
    buy: () => Promise.resolve(),
    buying: null,
    error: null,
    opened: null,
  }),
  useLibraosPlans: () => state.plans,
  useSubscribeLibraosPlan: () => ({
    canSubscribe: true,
    subscribe: () => Promise.resolve(),
    subscribing: null,
    error: null,
    opened: null,
  }),
}));

import { LibraosCreditsThreadError } from "./LibraosCreditsThreadError";

const environmentId = "env-1" as EnvironmentId;
const noop = () => {};
const plans: LibraosGatewayPlans = {
  plans: [
    {
      id: "pro",
      name: "Pro",
      priceUsd: 20,
      interval: "month",
      summary: "More tokens.",
      state: "available",
    },
  ],
  current: null,
  manageUrl: "https://console.libraos.com/plans",
};

it("says the credits ran out, shows the balance, and retries the failed run", async () => {
  state.plans = { ...state.plans, data: plans };
  state.credits = {
    ...state.credits,
    data: {
      availableUsd: 0,
      heldUsd: 0,
      enforced: true,
      amountsUsd: [10, 20],
      creditsUrl: "https://console.libraos.com/credits",
      plan: null,
    },
  };
  const retry = vi.fn();
  await using _screen = await render(
    <LibraosCreditsThreadError
      environmentId={environmentId}
      refusal="out-of-credits"
      provider="Claude Code (LibraOS)"
      onRetry={retry}
      retrying={false}
      onDismiss={noop}
    />,
  );
  await expect.element(page.getByText("Your LibraOS credits have run out.")).toBeVisible();
  await expect.element(page.getByText("$0 available")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Buy credits" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "See plans" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(retry).toHaveBeenCalledOnce();
});

it("without a resumable run offers Buy credits and asks for a new message instead of Retry", async () => {
  state.credits = { ...state.credits, data: null };
  // Console without plans: no See plans beside Buy credits.
  state.plans = { ...state.plans, data: null };
  await using _screen = await render(
    <LibraosCreditsThreadError
      environmentId={environmentId}
      refusal="out-of-credits"
      provider={null}
      onRetry={null}
      retrying={false}
      onDismiss={noop}
    />,
  );
  await expect.element(page.getByText(/then send a message to continue/)).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Buy credits" }))
    .toHaveAttribute("href", "https://console.libraos.com/credits");
  await expect.element(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "See plans" })).not.toBeInTheDocument();
});

it("tells a used-up Token Plan apart, with Buy credits, See plans and no Retry", async () => {
  state.credits = { ...state.credits, data: null };
  state.plans = { ...state.plans, data: plans };
  await using _screen = await render(
    <LibraosCreditsThreadError
      environmentId={environmentId}
      refusal="plan-limit"
      provider={null}
      onRetry={null}
      retrying={false}
      onDismiss={noop}
    />,
  );
  await expect.element(page.getByText("Your Token Plan is used up.")).toBeVisible();
  await expect.element(page.getByText(/keep working until the plan renews/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "See plans" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "LibraOS plans" }).getByText("$20 per month"))
    .toBeVisible();
});
