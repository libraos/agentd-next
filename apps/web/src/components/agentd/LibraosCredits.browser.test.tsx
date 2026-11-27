import type { EnvironmentId, LibraosGatewayCredits } from "@t3tools/contracts";
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
  buying: {
    canBuy: true,
    buy: (_usd: number) => Promise.resolve(),
    buying: null as number | null,
    error: null as string | null,
    opened: null as string | null,
  },
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosCredits: () => state.credits,
  useBuyLibraosCredits: () => state.buying,
}));

import { LibraosCreditsPanel } from "./LibraosCredits";

const environmentId = "env-1" as EnvironmentId;
const balance = (overrides: Partial<LibraosGatewayCredits> = {}): LibraosGatewayCredits => ({
  availableUsd: 12.34,
  heldUsd: 0,
  enforced: true,
  amountsUsd: [10, 20, 50],
  creditsUrl: "https://console.libraos.com/credits?ws=acme",
  plan: null,
  ...overrides,
});

function setup(credits: Partial<typeof state.credits>, buying: Partial<typeof state.buying> = {}) {
  const buy = vi.fn((_usd: number) => Promise.resolve());
  state.credits = { ...state.credits, data: null, error: null, isPending: false, ...credits };
  state.buying = { canBuy: true, buy, buying: null, error: null, opened: null, ...buying };
  return buy;
}

it("with no balance from Console shows only a Buy credits link, and no error", async () => {
  setup({ data: null });
  await using screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  const link = page.getByRole("link", { name: "Buy credits" });
  await expect.element(link).toHaveAttribute("href", "https://console.libraos.com/credits");
  expect(screen.container.textContent).toBe("Buy credits");
});

it("shows the balance, held credit and Console's amounts, and buys the one chosen", async () => {
  const buy = setup({ data: balance({ heldUsd: 0.5 }) });
  await using _screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  await expect
    .element(page.getByText("$12.34 available, $0.50 held by running work"))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Manage billing" }))
    .toHaveAttribute("href", "https://console.libraos.com/credits?ws=acme");
  await expect.element(page.getByText(/almost used up/)).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Buy $20" }).click();
  expect(buy).toHaveBeenCalledExactlyOnceWith(20);
});

it("warns when an enforced balance is almost used up", async () => {
  setup({ data: balance({ availableUsd: 1.5 }) });
  await using _screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  await expect.element(page.getByText("$1.50 available")).toBeVisible();
  await expect.element(page.getByText(/almost used up/)).toBeVisible();
});

it("says where to finish paying once the checkout is open", async () => {
  const url = "https://checkout.stripe.com/c/pay/cs_test_123";
  setup({ data: balance() }, { opened: url });
  await using _screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  await expect
    .element(
      page.getByText(/Finish paying in your browser; the balance updates when you come back/),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open the checkout page" }))
    .toHaveAttribute("href", url);
});

it("shows a refused checkout with the Credits page beside it", async () => {
  setup(
    { data: balance() },
    { error: "LibraOS could not start a checkout: Stripe did not answer." },
  );
  await using _screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  await expect
    .element(page.getByText(/could not start a checkout: Stripe did not answer/))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Buy on the Credits page" }))
    .toHaveAttribute("href", "https://console.libraos.com/credits?ws=acme");
});

it("cannot buy without permission to change this environment", async () => {
  setup({ data: balance() }, { canBuy: false });
  await using _screen = await render(<LibraosCreditsPanel environmentId={environmentId} />);
  await expect.element(page.getByRole("button", { name: "Buy $10" })).toBeDisabled();
});
