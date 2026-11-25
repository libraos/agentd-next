import type { EnvironmentId } from "@t3tools/contracts";

import { productProfile } from "../../productProfile";
import { useServerConfigs } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";

/** The connected environments whose server has workflows turned on in Labs. */
export function useWorkflowEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const connectedIds = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  if (!productProfile.workflows) return [];
  return connectedIds.filter((id) => configs.get(id)?.settings.workflowsEnabled === true);
}
