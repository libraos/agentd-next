import type { EnvironmentId, LibraosGatewayCredits } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  credits: {
    environmentId: "env-1",
    connected: false,
    data: null as LibraosGatewayCredits | null,
    error: null as string | null,
    isPending: false,
    refresh: () => {},
  },
}));

vi.mock("../../lib/libraosGatewayState", () => ({
  useLibraosCredits: () => state.credits,
}));

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

const mount = (credits: Partial<typeof state.credits>) => {
  state.credits = { ...state.credits, connected: false, data: null, ...credits };
  return render(
    <ul>
      <WelcomeLibraosRow
        environmentId={environmentId}
        gatewayLink={<a href="/welcome?screen=gateway" />}
      />
    </ul>,
  );
};

it("signed out, offers models without an agent to install and leads to Sign in", async () => {
  await using _screen = await mount({});
  await expect
    .element(page.getByText("No agent to install. Every model on one account, pay as you go."))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Sign in: LibraOS" }))
    .toHaveAttribute("href", "/welcome?screen=gateway");
  await expect.element(page.getByText(/trial/i)).not.toBeInTheDocument();
});

it("connected, shows the balance and leads to the Gateway panel", async () => {
  await using _screen = await mount({ connected: true, data: balance(12.34) });
  await expect.element(page.getByText("Connected · $12.34 available")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Manage: LibraOS" }))
    .toHaveAttribute("href", "/welcome?screen=gateway");
});

it("connected with no balance from Console, says only that it is connected", async () => {
  await using _screen = await mount({ connected: true, data: null });
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
});
