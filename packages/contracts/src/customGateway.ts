import * as Schema from "effect/Schema";

import { isLibraosGatewayInstanceId } from "./libraosGateway.ts";

// A gateway the user adds by URL (a company proxy, LiteLLM, OpenRouter): it becomes provider
// instances for the agents that speak its format. The server keeps its key; clients see hasKey.

export const CustomGatewayFormat = Schema.Literals(["openai", "anthropic"]);
export type CustomGatewayFormat = typeof CustomGatewayFormat.Type;

const GATEWAY_ID_PATTERN = /^[a-z0-9]{1,16}$/;
export const CustomGatewayId = Schema.String.check(Schema.isPattern(GATEWAY_ID_PATTERN));

const INSTANCE_ID_PATTERN = /^gw-([a-z0-9]{1,16})-(?:claude|codex|opencode|pi)$/;

/** The gateway id of one of a custom gateway's provider instances, else null. */
export const customGatewayIdOfInstance = (instanceId: string): string | null =>
  INSTANCE_ID_PATTERN.exec(instanceId)?.[1] ?? null;

/** The instance's models are a gateway's list, so a model missing from it was taken away. */
export const isGatewayInstanceId = (instanceId: string): boolean =>
  isLibraosGatewayInstanceId(instanceId) || customGatewayIdOfInstance(instanceId) !== null;

export const CustomGatewayAgent = Schema.Literals(["claude", "codex", "opencode", "pi"]);
export type CustomGatewayAgent = typeof CustomGatewayAgent.Type;

/** The agents that speak a format: opencode speaks both, Pi only OpenAI's here. */
export const customGatewayAgentsOf = (
  format: CustomGatewayFormat,
): ReadonlyArray<CustomGatewayAgent> =>
  format === "anthropic" ? ["claude", "opencode"] : ["codex", "opencode", "pi"];

/** What agentd's `[dispatch] TOOL_base_url` takes for a gateway: Claude Code an origin, the others `/v1`. */
export function customGatewayWorkerUrl(agent: CustomGatewayAgent, url: string): string {
  const origin = url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return agent === "claude" ? origin : `${origin}/v1`;
}

/** Stored in server settings; the key is in the server's secret store. */
export const CustomGatewaySetting = Schema.Struct({
  id: CustomGatewayId,
  name: Schema.String,
  url: Schema.String,
  format: CustomGatewayFormat,
  /** Models the gateway lists that its agents do not offer. */
  hiddenModels: Schema.optional(Schema.Array(Schema.String)),
});
export type CustomGatewaySetting = typeof CustomGatewaySetting.Type;

export const CustomGatewaySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  format: CustomGatewayFormat,
  hasKey: Schema.Boolean,
  modelCount: Schema.Number,
  /** The models its agents offer, and the ones turned off. */
  models: Schema.Array(Schema.String),
  hiddenModels: Schema.Array(Schema.String),
  /** The agents this gateway has on this environment. */
  agents: Schema.Array(CustomGatewayAgent),
});
export type CustomGatewaySummary = typeof CustomGatewaySummary.Type;

const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const CustomGatewayAddInput = Schema.Struct({
  url: Bounded(2048),
  format: CustomGatewayFormat,
  key: Schema.optional(Bounded(4096)),
  name: Schema.optional(Bounded(200)),
  /** The agents to add; without it, every agent that speaks the format. */
  agents: Schema.optional(Schema.Array(CustomGatewayAgent)),
  /** Model ids typed by the user; given, the gateway's model list is not asked. */
  models: Schema.optional(Schema.Array(Bounded(256)).check(Schema.isMaxLength(500))),
});
export type CustomGatewayAddInput = typeof CustomGatewayAddInput.Type;

export const CustomGatewayAddResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("added"), gateway: CustomGatewaySummary }),
  /** The model list could not be read; the gateway is not saved. */
  Schema.Struct({ kind: Schema.Literal("modelsProblem"), message: Schema.String }),
]);
export type CustomGatewayAddResult = typeof CustomGatewayAddResult.Type;

export const CustomGatewayRenameInput = Schema.Struct({
  id: Schema.String,
  name: Bounded(200),
});
export type CustomGatewayRenameInput = typeof CustomGatewayRenameInput.Type;

export const CustomGatewayHiddenModelsInput = Schema.Struct({
  id: Schema.String,
  hiddenModels: Schema.Array(Bounded(256)).check(Schema.isMaxLength(2000)),
});
export type CustomGatewayHiddenModelsInput = typeof CustomGatewayHiddenModelsInput.Type;

export const CustomGatewayIdInput = Schema.Struct({ id: Schema.String });
export type CustomGatewayIdInput = typeof CustomGatewayIdInput.Type;

export const CustomGatewayList = Schema.Struct({ gateways: Schema.Array(CustomGatewaySummary) });
export type CustomGatewayList = typeof CustomGatewayList.Type;

export class CustomGatewayError extends Schema.TaggedError<CustomGatewayError>()(
  "CustomGatewayError",
  { message: Schema.String },
) {}
