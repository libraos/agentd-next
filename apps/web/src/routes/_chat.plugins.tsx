import { createFileRoute } from "@tanstack/react-router";

import { PluginsPage } from "../components/agentd/PluginsPage";

export const Route = createFileRoute("/_chat/plugins")({
  component: PluginsPage,
});
