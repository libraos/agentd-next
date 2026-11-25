import { useLocation } from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { openCommandPalette } from "../../commandPaletteBus";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { CommandPalette } from "../CommandPalette";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { AgentdPage } from "./AgentdPage";

function AgentdEntryPoints() {
  const onAgentdPage = useLocation({ select: (location) => location.pathname === "/agentd" });
  return (
    <TooltipProvider>
      <SidebarProvider>
        <CommandPalette>
          <SidebarChromeFooter />
          {onAgentdPage ? <AgentdPage /> : null}
        </CommandPalette>
      </SidebarProvider>
    </TooltipProvider>
  );
}

it("opens LibraOS Engine from the sidebar footer and the command palette", async () => {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  await using screen = await render(<AgentdEntryPoints />);
  const dialog = page.getByRole("dialog", { name: "LibraOS Engine" });

  await screen.getByRole("button", { name: "LibraOS Engine", exact: true }).click();
  await expect.element(dialog.getByRole("heading", { name: "Status" })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/agentd");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(screen.router?.state.location.pathname).toBe("/");

  openCommandPalette({ query: "Open LibraOS Engine" });
  await page.getByRole("option", { name: "Open LibraOS Engine" }).click();
  await expect.element(dialog.getByRole("heading", { name: "Status" })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/agentd");
});
