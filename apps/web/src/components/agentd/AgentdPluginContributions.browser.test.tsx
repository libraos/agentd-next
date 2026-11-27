import type { AgentdPluginListing } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { AgentdPluginContributions } from "./AgentdPluginContributions";

const plugin: AgentdPluginListing = {
  id: "gh~acme~plugins~outreach",
  origin: { kind: "github", repository: "acme/plugins" },
  name: "Outreach mailer",
  description: "",
  author: "",
  licence: "",
  version: "0.1.0",
  installedVersion: "0.1.0",
  hooks: [],
  enabled: false,
  state: "off",
  mcpServers: [
    {
      name: "outreach",
      command: "outreach",
      args: ["mcp", "--stdio"],
      env: ["OUTREACH_URL", "OUTREACH_API_KEY_FILE"],
      missing: ["outreach_token"],
    },
  ],
  settings: [
    {
      name: "outreach_url",
      label: "Outreach URL",
      secret: false,
      value: "https://outreach.example",
      set: true,
    },
    { name: "outreach_token", label: "Outreach API key", secret: true, set: true },
  ],
};

it("shows each server's exact command and a settings form with the secret masked", async () => {
  const onSave = vi.fn();
  await using _screen = await render(
    <AgentdPluginContributions plugin={plugin} disabled={false} onSave={onSave} />,
  );
  await expect.element(page.getByText("outreach mcp --stdio")).toBeVisible();
  await expect.element(page.getByText("Source: acme (private)")).toBeVisible();
  await expect
    .element(page.getByText("Not given to agents until these are set: Outreach API key"))
    .toBeVisible();
  await expect.element(page.getByLabelText("Outreach URL")).toHaveValue("https://outreach.example");
  const key = page.getByLabelText("Outreach API key");
  await expect.element(key).toHaveAttribute("type", "password");
  await expect.element(key).toHaveValue("");

  // Typing into the secret and emptying it again keeps the saved secret.
  await userEvent.type(key, "abc");
  await userEvent.clear(key);
  await userEvent.clear(page.getByLabelText("Outreach URL"));
  await userEvent.type(page.getByLabelText("Outreach URL"), "https://other.example");
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ outreach_url: "https://other.example" });

  await page.getByRole("button", { name: "Clear Outreach API key" }).click();
  expect(onSave).toHaveBeenLastCalledWith({ outreach_token: null });
});

it("shows why a server cannot be started here", async () => {
  const problem = "legal is a Python script and Python 3 was not found.";
  await using _screen = await render(
    <AgentdPluginContributions
      plugin={{
        ...plugin,
        mcpServers: [
          { name: "legal", command: "./legal_mcp.py", args: [], env: [], missing: [], problem },
        ],
        settings: [],
      }}
      disabled={false}
      onSave={() => {}}
    />,
  );
  await expect.element(page.getByText("./legal_mcp.py")).toBeVisible();
  await expect.element(page.getByText(problem)).toBeVisible();
});
