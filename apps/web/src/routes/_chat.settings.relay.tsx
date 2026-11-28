import { createFileRoute } from "@tanstack/react-router";

import { RelaySettings } from "../components/agentd/RelaySettings";

export const Route = createFileRoute("/_chat/settings/relay")({
  component: RelaySettings,
});
