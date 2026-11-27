import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { AgentdPagePlugins } from "./AgentdPagePlugins";

export function PluginsPage() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);

  return (
    <AppRouteModal label={gt("Plugins")}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 sm:px-7">
        <h1 className="text-lg font-semibold">
          <T>Plugins</T>
        </h1>
        <AppRouteModalClose />
      </header>
      <div className="min-h-0 grow overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto grid max-w-4xl gap-4 p-5 sm:p-7">
          {environmentId === null ? (
            <p className="text-sm text-muted-foreground">
              <T>No environment is connected.</T>
            </p>
          ) : !canRead ? (
            <p className="text-sm text-muted-foreground">
              <T>Plugins require read access to this environment.</T>
            </p>
          ) : (
            <AgentdPagePlugins environmentId={environmentId} />
          )}
        </div>
      </div>
    </AppRouteModal>
  );
}
