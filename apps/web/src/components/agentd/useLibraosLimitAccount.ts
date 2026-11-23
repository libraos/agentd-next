import type { EnvironmentId } from "@t3tools/contracts";
import {
  type LibraosReading,
  type LimitAccount,
  libraosLimitAccount,
  nextLibraosReading,
} from "@t3tools/shared/usageLimits";
import { libraosCopy } from "@t3tools/shared/usageLimitsCopy";
import { useMessages } from "gt-react";
import { useState } from "react";

import { useAgentdCloudBalance } from "../../lib/agentdState";

/** The LibraOS account as a usage row, or null; a failed read keeps the last good one. */
export function useLibraosLimitAccount(
  environmentLabel: (environmentId: EnvironmentId) => string | null,
): LimitAccount | null {
  const messages = useMessages();
  const { environmentId, data, dataUpdatedAt } = useAgentdCloudBalance();
  const [kept, setKept] = useState<{
    readonly data: typeof data;
    readonly reading: LibraosReading | null;
  }>({ data: null, reading: null });
  let reading = kept.reading;
  if (data !== kept.data) {
    reading = nextLibraosReading(kept.reading, data, dataUpdatedAt);
    setKept({ data, reading });
  }
  const label = environmentId === null ? null : environmentLabel(environmentId);
  if (environmentId === null || label === null) return null;
  return libraosLimitAccount(reading, { environmentId, label }, libraosCopy(messages));
}
