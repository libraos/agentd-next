import type { EnvironmentId, RelayHostRevokeResult, RelayHostStatus } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  status: null as RelayHostStatus | null,
  error: null as string | null,
  isPending: false,
  canRevoke: true,
  revoke: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../lib/relayHostState", () => ({
  useRelayHostStatus: () => ({
    data: state.status,
    error: state.error,
    isPending: state.isPending,
    refresh: () => {},
  }),
  useRelayHostCommands: () => ({ canRevoke: state.canRevoke, revokeDevice: state.revoke }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: state.confirm }));

import { RelaySettings } from "./RelaySettings";

const environmentId = "env-1" as EnvironmentId;
const PAIRED = "2026-01-01T10:00:00.000Z";

const connected: RelayHostStatus = {
  relay: { relayUrl: "https://relay.example.com", hostId: "host-1", online: true },
  devices: [
    { deviceId: "dev-1", label: "My phone", addedAt: PAIRED, lastConnectedAt: PAIRED },
    { deviceId: "dev-2", label: "", addedAt: PAIRED, lastConnectedAt: null },
  ],
};

function setup(overrides: Partial<Omit<typeof state, "revoke" | "confirm">> = {}) {
  Object.assign(state, {
    status: connected,
    error: null,
    isPending: false,
    canRevoke: true,
    ...overrides,
  });
  state.confirm.mockReset().mockResolvedValue(true);
  state.revoke.mockReset().mockResolvedValue(
    AsyncResult.success({
      keyRemoved: true,
      relayFailure: null,
      status: { ...connected, devices: connected.devices.slice(1) },
    } satisfies RelayHostRevokeResult),
  );
}

it("shows the relay, its connection and each relay device with when it last connected", async () => {
  setup();
  await using _screen = await render(<RelaySettings />);
  await expect.element(page.getByText("https://relay.example.com")).toBeVisible();
  await expect.element(page.getByText("Host id host-1")).toBeVisible();
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.element(page.getByText("My phone")).toBeVisible();
  await expect.element(page.getByText(/Last connected/)).toBeVisible();
  await expect.element(page.getByText("Unnamed device")).toBeVisible();
  await expect.element(page.getByText(/Not connected since it was paired/)).toBeVisible();
});

it("says how to turn the relay on when this computer has none", async () => {
  setup({ status: { relay: null, devices: [] } });
  await using _screen = await render(<RelaySettings />);
  await expect.element(page.getByText(/is not connected to a relay/)).toBeVisible();
  await expect
    .element(page.getByText("lnext relay connect <relay-url> --token <token>"))
    .toBeVisible();
  await expect.element(page.getByText(/No devices are paired through the relay/)).toBeVisible();
});

it("revokes a device only after the person confirms", async () => {
  setup();
  await using _screen = await render(<RelaySettings />);
  state.confirm.mockResolvedValueOnce(false);
  await page.getByRole("button", { name: "Revoke My phone" }).click();
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
  expect(state.revoke).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Revoke My phone" }).click();
  await vi.waitFor(() =>
    expect(state.revoke).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { deviceId: "dev-1" },
    }),
  );
});

it("says so when the relay could not drop a device whose key is gone", async () => {
  setup();
  state.revoke.mockResolvedValue(
    AsyncResult.success({
      keyRemoved: true,
      relayFailure: "The relay did not revoke the device (HTTP 500).",
      status: connected,
    } satisfies RelayHostRevokeResult),
  );
  await using _screen = await render(<RelaySettings />);
  await page.getByRole("button", { name: "Revoke My phone" }).click();
  const notice = page.getByText(/the relay did not drop it: .*HTTP 500/);
  await expect.element(notice).toBeVisible();
  await expect.element(notice).toHaveAttribute("role", "alert");
});

it("offers no Revoke to a session that cannot change access, and nothing to one that cannot read it", async () => {
  setup({ canRevoke: false });
  {
    await using _screen = await render(<RelaySettings />);
    await expect.element(page.getByText("My phone")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
  }
  setup({ status: null });
  await using _screen = await render(<RelaySettings />);
  await expect.element(page.getByText(/cannot view this computer's relay/)).toBeVisible();
  await expect.element(page.getByText("My phone")).not.toBeInTheDocument();
});
