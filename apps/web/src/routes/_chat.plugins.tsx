import { createFileRoute } from "@tanstack/react-router";

import { PluginsPage } from "../components/agentd/PluginsPage";
import { type CustomizePane, CUSTOMIZE_PANES } from "../components/agentd/customizePanes";

export const Route = createFileRoute("/_chat/plugins")({
  validateSearch: (raw: Record<string, unknown>): { pane?: CustomizePane } => {
    const pane = CUSTOMIZE_PANES.find((candidate) => candidate === raw.pane);
    return pane === undefined || pane === "plugins" ? {} : { pane };
  },
  component: PluginsPage,
});
