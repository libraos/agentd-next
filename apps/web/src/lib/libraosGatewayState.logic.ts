import {
  isLibraosGatewayInstanceId,
  type LibraosGatewayStatus,
  type ServerProvider,
} from "@t3tools/contracts";

/** A key the Gateway refuses cannot pay for a worker, though it is still stored. */
export function isLibraosGatewayUsable(
  status: Pick<LibraosGatewayStatus, "connected" | "refusal"> | null | undefined,
): boolean {
  return status?.connected === true && !status.refusal;
}

/**
 * Changes when the Gateway agents are probed again. A provider refresh re-reads the key first, so
 * the Gateway's status is stale from then on.
 */
export function libraosGatewayAgentsChecked(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "checkedAt">> | null,
): string {
  return (providers ?? [])
    .filter((provider) => isLibraosGatewayInstanceId(provider.instanceId))
    .map((provider) => `${provider.instanceId}@${provider.checkedAt}`)
    .toSorted()
    .join(",");
}
