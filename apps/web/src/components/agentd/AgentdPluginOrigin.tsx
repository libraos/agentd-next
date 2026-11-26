import type { AgentdPluginOrigin } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Badge } from "../ui/badge";

/** Official, OWNER (private) or Local: where a plugin came from, in words. */
export function usePluginOriginLabel() {
  const gt = useGT();
  return (origin: AgentdPluginOrigin) =>
    origin.kind === "official"
      ? gt("Official", { $context: "plugin source: the LibraOS catalogue" })
      : origin.kind === "local"
        ? gt("Local", { $context: "plugin source: a folder on this computer" })
        : gt("{owner} (private)", { owner: origin.repository.split("/")[0] ?? origin.repository });
}

export function PluginOriginBadge({ origin }: { readonly origin: AgentdPluginOrigin }) {
  const label = usePluginOriginLabel();
  return (
    <Badge
      variant={
        origin.kind === "official" ? "outline" : origin.kind === "local" ? "secondary" : "info"
      }
    >
      {label(origin)}
    </Badge>
  );
}
