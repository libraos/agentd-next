import * as Schema from "effect/Schema";

// The LibraOS Gateway: a Console API key (lk_…) that agentd's workers and the app's chats use for
// model access, pay as you go. The server keeps the key; clients only see whether it is connected.

export const LIBRAOS_GATEWAY_ORIGIN = "https://api.libraos.com";
export const LIBRAOS_CONSOLE_API_KEYS_URL = "https://console.libraos.com/api-keys";
/** LibraOS Cloud (Console): device sign-in (RFC 8628) and the Gateway keys a sign-in may make. */
export const LIBRAOS_CLOUD_ORIGIN = "https://console.libraos.com";
export const LIBRAOS_DEVICE_CLIENT_ID = "agentd-desktop";

export const LibraosGatewaySignInPurpose = Schema.Literals(["connect", "revoke"]);
export type LibraosGatewaySignInPurpose = typeof LibraosGatewaySignInPurpose.Type;

/** A device sign-in waiting for the person to approve its code in the browser. */
export const LibraosGatewaySignIn = Schema.Struct({
  /** connect: make a Gateway key and connect it; revoke: revoke the connected key, then disconnect. */
  purpose: LibraosGatewaySignInPurpose,
  userCode: Schema.String,
  verificationUri: Schema.String,
  /** The verification page with the code filled in. */
  verificationUriComplete: Schema.String,
  /** Epoch milliseconds. */
  expiresAt: Schema.Number,
});
export type LibraosGatewaySignIn = typeof LibraosGatewaySignIn.Type;

export const LibraosGatewayAccount = Schema.Struct({
  email: Schema.String,
  workspace: Schema.String,
});
export type LibraosGatewayAccount = typeof LibraosGatewayAccount.Type;

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
  /** The account a sign-in made the key for; null for a pasted key. Disconnect then revokes it. */
  account: Schema.NullOr(LibraosGatewayAccount),
  /** The device sign-in waiting for approval, if any. */
  signIn: Schema.NullOr(LibraosGatewaySignIn),
  /** What the last disconnect did to the key in LibraOS (revoked, or why not). */
  notice: Schema.NullOr(Schema.String),
});
export type LibraosGatewayStatus = typeof LibraosGatewayStatus.Type;

export const LibraosGatewayConnectInput = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(4096)),
});
export type LibraosGatewayConnectInput = typeof LibraosGatewayConnectInput.Type;

export const LibraosGatewaySignInStartInput = Schema.Struct({
  purpose: LibraosGatewaySignInPurpose,
});
export type LibraosGatewaySignInStartInput = typeof LibraosGatewaySignInStartInput.Type;

export class LibraosGatewayError extends Schema.TaggedError<LibraosGatewayError>()(
  "LibraosGatewayError",
  {
    /** The Gateway's own message for a refused key, or what went wrong on this host. */
    message: Schema.String,
  },
) {}
