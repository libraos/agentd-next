import type { AgentdPermissionModeState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  lower: vi.fn(),
  refresh: vi.fn(),
  mode: { mode: "yolo", scopedYolo: false } as AgentdPermissionModeState,
}));

vi.mock("../../lib/agentdState", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    agentdEnvironment: { lowerPermissionMode: { permissionAtom: () => allowed } },
    useAgentdCommands: () => ({ lowerPermissionMode: state.lower }),
    useAgentdPermissionMode: () => ({ data: state.mode, error: null, refresh: state.refresh }),
  };
});

import {
  PermissionModeChoice,
  RAISE_PERMISSION_COMMAND,
  WorkerPermissionModeRow,
} from "./WorkerPermissionMode";

const environmentId = "env-1" as EnvironmentId;

function setup(mode: AgentdPermissionModeState["mode"]) {
  state.mode = { mode, scopedYolo: false };
  state.refresh.mockReset();
  state.lower.mockReset().mockResolvedValue(AsyncResult.success({ mode: "guarded" }));
}

function Choice({ onChange }: { readonly onChange: (mode: string) => void }) {
  const [value, setValue] = useState<"guarded" | "yolo" | null>(null);
  return (
    <PermissionModeChoice
      value={value}
      disabled={false}
      onChange={(mode) => {
        setValue(mode);
        onChange(mode);
      }}
    />
  );
}

it("asks with neither choice selected until the person picks one", async () => {
  const onChange = vi.fn();
  await using _screen = await render(<Choice onChange={onChange} />);
  const askFirst = page.getByRole("radio", { name: /Ask first/ });
  const runWithout = page.getByRole("radio", { name: /Run without asking/ });
  await expect.element(askFirst).not.toBeChecked();
  await expect.element(runWithout).not.toBeChecked();
  await runWithout.click();
  await expect.element(runWithout).toBeChecked();
  expect(onChange).toHaveBeenCalledWith("yolo");
});

it("lowers a mode read from agentd with Ask first", async () => {
  setup("yolo");
  await using _screen = await render(<WorkerPermissionModeRow environmentId={environmentId} />);
  await expect.element(page.getByText("Run without asking")).toBeVisible();
  await page.getByRole("button", { name: "Ask first" }).click();
  expect(state.lower).toHaveBeenCalledWith({ environmentId, input: {} });
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
});

it("shows the terminal command to run without asking and changes nothing itself", async () => {
  setup("guarded");
  await using _screen = await render(<WorkerPermissionModeRow environmentId={environmentId} />);
  await expect.element(page.getByText("Ask first")).toBeVisible();
  await page.getByRole("button", { name: "Run without asking" }).click();
  await expect.element(page.getByText(RAISE_PERMISSION_COMMAND)).toBeVisible();
  expect(state.lower).not.toHaveBeenCalled();
});
