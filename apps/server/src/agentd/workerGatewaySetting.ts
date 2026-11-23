// Settings → Workers: which of this environment's gateways a tool's local workers use. agentd
// keeps the setting; it is given the gateway's key as the path of the secret-store file.
import {
  type AgentdWorkerGateway,
  type AgentdWorkerGatewayInput,
  type CustomGatewaySummary,
  customGatewayAgentsOf,
  customGatewayWorkerUrl,
} from "@t3tools/contracts";

import { customGatewayKeySecret } from "../gateway/gatewaySetup.ts";

/** The gateway's key in the server's secret store, as a file agentd reads. */
export const workerGatewayKeyFile = (
  secretsDir: string,
  join: (...parts: ReadonlyArray<string>) => string,
  id: string,
) => join(secretsDir, `${customGatewayKeySecret(id)}.bin`);

export interface WorkerGatewayChoice {
  readonly url: string;
  readonly keyFile: string | null;
  readonly model: string;
}

/** The setting for the chosen gateway, or why it cannot be one. */
export function workerGatewayChoice(
  input: AgentdWorkerGatewayInput & { readonly gateway: {} },
  gateways: ReadonlyArray<CustomGatewaySummary>,
  keyFile: (id: string) => string,
): WorkerGatewayChoice | { readonly refused: string } {
  const refuse = (refused: string) => ({ refused });
  const gateway = gateways.find((candidate) => candidate.id === input.gateway.id);
  if (gateway === undefined) return refuse("That gateway is no longer in Providers.");
  if (!customGatewayAgentsOf(gateway.format).includes(input.tool)) {
    return refuse(`${gateway.name} does not speak the format ${input.tool} needs.`);
  }
  if (!gateway.models.includes(input.gateway.model)) {
    return refuse(`${gateway.name} does not offer ${input.gateway.model}.`);
  }
  return {
    url: customGatewayWorkerUrl(input.tool, gateway.url),
    keyFile: gateway.hasKey ? keyFile(gateway.id) : null,
    model: input.gateway.model,
  };
}

const TOOLS = ["claude", "codex", "opencode"] as const;

/** The record of which gateway each tool was last given, as stored beside the server's state. */
export function readWorkerGatewayRecord(text: string): AgentdWorkerGateway["chosen"] {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    // An unreadable record is no record.
  }
  const entries = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = (tool: string) => (typeof entries[tool] === "string" ? entries[tool] : null);
  return { claude: id(TOOLS[0]), codex: id(TOOLS[1]), opencode: id(TOOLS[2]) };
}

export const workerGatewayRecordText = (chosen: AgentdWorkerGateway["chosen"]): string =>
  JSON.stringify(chosen);
