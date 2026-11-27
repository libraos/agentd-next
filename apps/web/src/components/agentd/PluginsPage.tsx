import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { AgentdPagePlugins } from "./AgentdPagePlugins";
import { CustomizeConnectors } from "./CustomizeConnectors";
import { CustomizeSkills } from "./CustomizeSkills";
import { CUSTOMIZE_PANES, type CustomizePane } from "./customizePanes";

/** Plugins, and the agents' own connectors and skills: a nav, then each pane's list and detail. */
export function PluginsPage() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const pane: CustomizePane = useSearch({ from: "/_chat/plugins" }).pane ?? "plugins";
  const labels: Record<CustomizePane, string> = {
    plugins: gt("Plugins"),
    connectors: gt("Connectors"),
    skills: gt("Skills"),
  };

  return (
    <AppRouteModal label={gt("Customize")}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 sm:px-7">
        <h1 className="text-lg font-semibold">
          <T>Customize</T>
        </h1>
        <AppRouteModalClose />
      </header>
      <div className="flex min-h-0 grow flex-col sm:flex-row">
        <nav
          aria-label={gt("Customize")}
          className="flex shrink-0 gap-1 border-b border-border p-2 sm:w-44 sm:flex-col sm:border-e sm:border-b-0"
        >
          {CUSTOMIZE_PANES.map((candidate) => (
            <Link
              key={candidate}
              to="/plugins"
              search={candidate === "plugins" ? {} : { pane: candidate }}
              aria-current={candidate === pane ? "page" : undefined}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
            >
              {labels[candidate]}
            </Link>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 grow">
          {environmentId === null ? (
            <p className="p-5 text-sm text-muted-foreground">
              <T>No environment is connected.</T>
            </p>
          ) : !canRead ? (
            <p className="p-5 text-sm text-muted-foreground">
              <T>Customize requires read access to this environment.</T>
            </p>
          ) : pane === "connectors" ? (
            <CustomizeConnectors environmentId={environmentId} />
          ) : pane === "skills" ? (
            <CustomizeSkills environmentId={environmentId} />
          ) : (
            <div className="min-h-0 grow overflow-y-auto scrollbar-gutter-both">
              <div className="mx-auto grid max-w-4xl gap-4 p-5 sm:p-7">
                <AgentdPagePlugins environmentId={environmentId} />
              </div>
            </div>
          )}
        </div>
      </div>
    </AppRouteModal>
  );
}
