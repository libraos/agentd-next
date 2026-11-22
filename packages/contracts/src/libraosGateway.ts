import * as Schema from "effect/Schema";

// The LibraOS Gateway: a Console API key (lk_…) that agentd's workers and the app's chats use for
// model access, pay as you go. The server keeps the key; clients only see whether it is connected.

export const LIBRAOS_GATEWAY_ORIGIN = "https://api.libraos.com";
export const LIBRAOS_CONSOLE_API_KEYS_URL = "https://console.libraos.com/api-keys";

/** The provider instances a connected key adds; their models are the key's, not the user's. */
export const LIBRAOS_GATEWAY_INSTANCE_IDS = {
  claude: "libraosClaude",
  codex: "libraosCodex",
  opencode: "libraosOpencode",
  pi: "libraosPi",
} as const;

export const isLibraosGatewayInstanceId = (instanceId: string): boolean =>
  Object.values(LIBRAOS_GATEWAY_INSTANCE_IDS).some((id) => id === instanceId);

/** The model is one of a sub-provider whose list the key it sends to its endpoint decides. */
export const isEndpointDecidedModel = (
  auth: { readonly endpointProviders?: ReadonlyArray<string> | undefined },
  slug: string,
): boolean => {
  const separator = slug.indexOf("/");
  return separator > 0 && (auth.endpointProviders?.includes(slug.slice(0, separator)) ?? false);
};

export const LibraosGatewayModel = Schema.Struct({
  /** The Gateway's id, such as `anthropic/claude-opus-5-5`. */
  id: Schema.String,
  name: Schema.optional(Schema.String),
});
export type LibraosGatewayModel = typeof LibraosGatewayModel.Type;

export const LibraosGatewayAgentdSetup = Schema.Struct({
  /** agentd took the key: `init --model-key` exited 0. */
  ok: Schema.Boolean,
  /** What agentd printed, or why it did not run. */
  output: Schema.String,
});
export type LibraosGatewayAgentdSetup = typeof LibraosGatewayAgentdSetup.Type;

export const LibraosGatewayStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The models the key may use, from its last check; empty while not connected. */
  models: Schema.Array(LibraosGatewayModel),
  /** agentd's answer to the last connect since the server started; null before one. */
  agentd: Schema.NullOr(LibraosGatewayAgentdSetup),
  /** The Gateway's reason for refusing the key at its last refresh; null while it serves it. */
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
});
export type LibraosGatewayStatus = typeof LibraosGatewayStatus.Type;

export const LibraosGatewayConnectInput = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(4096)),
});
export type LibraosGatewayConnectInput = typeof LibraosGatewayConnectInput.Type;

export class LibraosGatewayError extends Schema.TaggedError<LibraosGatewayError>()(
  "LibraosGatewayError",
  {
    /** The Gateway's own message for a refused key, or what went wrong on this host. */
    message: Schema.String,
  },
) {}
