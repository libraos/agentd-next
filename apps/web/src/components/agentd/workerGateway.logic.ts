import {
  type AgentdDoctorCheck,
  type AgentdWorkerGateway,
  type AgentdWorkerTool,
  type CustomGatewaySummary,
  customGatewayAgentsOf,
  customGatewayWorkerUrl,
} from "@t3tools/contracts";

/** agentd's own line for a tool whose workers go through a gateway, from its login check. */
export function workerGatewayLine(
  tool: AgentdWorkerTool,
  checks: ReadonlyArray<AgentdDoctorCheck>,
): string | null {
  const detail = checks.find((check) => check.id === `${tool}-login`)?.detail ?? null;
  return detail !== null && detail.startsWith("workers use ") ? detail : null;
}

/** The gateways a tool's workers can use: the ones speaking its format. */
export const workerGatewaysFor = (
  tool: AgentdWorkerTool,
  gateways: ReadonlyArray<CustomGatewaySummary>,
): ReadonlyArray<CustomGatewaySummary> =>
  gateways.filter((gateway) => customGatewayAgentsOf(gateway.format).includes(tool));

/**
 * The gateway a tool's workers use now: the one this app set, while agentd still names its URL.
 * agentd has no such line for opencode, so the app's record stands there.
 */
export function workerGatewayNow(
  tool: AgentdWorkerTool,
  setting: AgentdWorkerGateway,
  gateways: ReadonlyArray<CustomGatewaySummary>,
  checks: ReadonlyArray<AgentdDoctorCheck>,
): CustomGatewaySummary | null {
  const gateway = workerGatewaysFor(tool, gateways).find(
    (candidate) => candidate.id === setting.chosen[tool],
  );
  if (gateway === undefined) return null;
  const line = workerGatewayLine(tool, checks);
  if (tool === "opencode" && line === null) return gateway;
  return line?.startsWith(`workers use ${customGatewayWorkerUrl(tool, gateway.url)} `) === true ||
    line?.startsWith(`workers use ${customGatewayWorkerUrl(tool, gateway.url)},`) === true
    ? gateway
    : null;
}
