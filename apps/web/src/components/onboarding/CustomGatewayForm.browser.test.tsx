import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type CustomGatewaySummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { CustomGatewayForm } from "./CustomGatewayForm";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../lib/customGatewayState", () => ({
  useCustomGatewayCommands: () => ({ canChange: true, add }),
}));

it.for([
  { format: "openai", agent: "Claude Code", hasKey: true },
  { format: "openai", agent: "Claude Code", hasKey: false },
  { format: "anthropic", agent: "Codex", hasKey: true },
] as const)(
  "offers to add $agent to the same $format gateway (stored key: $hasKey)",
  async ({ format, agent, hasKey }) => {
    const gateway: CustomGatewaySummary = {
      id: "work",
      name: "Work",
      url: "https://gateway.example.com/v1",
      format,
      hasKey,
      modelCount: 1,
      models: ["model"],
      hiddenModels: [],
      agents: format === "openai" ? ["codex", "opencode", "pi"] : ["claude", "opencode"],
    };
    add
      .mockReset()
      .mockResolvedValueOnce(AsyncResult.success({ kind: "added", gateway }))
      .mockResolvedValueOnce(
        AsyncResult.success({
          kind: "added",
          gateway: {
            ...gateway,
            format: "both",
            hasKey: true,
            agents: ["claude", "codex", "opencode"],
          },
        }),
      );
    const environmentId = EnvironmentId.make("test");
    await using screen = await render(<CustomGatewayForm environmentId={environmentId} />);
    await screen.getByLabelText("Endpoint URL").fill(gateway.url);
    if (format === "anthropic")
      await screen.getByRole("radio", { name: "Anthropic", exact: true }).click();
    if (hasKey)
      await screen
        .getByLabelText(format === "anthropic" ? "Key" : "Key (optional)", { exact: true })
        .fill("original-key");
    await screen.getByRole("button", { name: "Add gateway" }).click();

    await expect
      .element(screen.getByText(`The built-in ${agent} still uses its own sign-in.`))
      .toBeVisible();
    const action = screen.getByRole("button", { name: `Also use Work for ${agent}` });
    if (!hasKey) {
      await expect.element(action).toBeDisabled();
      await screen.getByLabelText("Gateway key").fill("upgrade-key");
    }
    await action.click();
    expect(add).toHaveBeenLastCalledWith({
      environmentId,
      input: { extendId: gateway.id, ...(hasKey ? {} : { key: "upgrade-key" }) },
    });
    await expect.element(action).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Work is used by Claude Code, Codex, opencode."))
      .toBeVisible();
  },
);

it("adds both formats with one URL and key", async () => {
  const gateway: CustomGatewaySummary = {
    id: "work",
    name: "Work",
    url: "https://gateway.example.com",
    format: "both",
    hasKey: true,
    modelCount: 1,
    models: ["model"],
    hiddenModels: [],
    agents: ["claude", "codex", "opencode", "pi"],
  };
  add.mockReset().mockResolvedValueOnce(AsyncResult.success({ kind: "added", gateway }));
  const environmentId = EnvironmentId.make("test");
  await using screen = await render(<CustomGatewayForm environmentId={environmentId} />);
  await screen.getByLabelText("Endpoint URL").fill(gateway.url);
  await screen.getByRole("radio", { name: "Both", exact: true }).click();
  await expect.element(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: "Codex" })).toBeChecked();
  await screen.getByLabelText("Key", { exact: true }).fill("original-key");
  await screen.getByRole("button", { name: "Add gateway" }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { url: gateway.url, format: "both", key: "original-key", agents: gateway.agents },
  });
  await expect
    .element(screen.getByText("Work is used by Claude Code, Codex, opencode, Pi."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Also use/ })).not.toBeInTheDocument();
});
