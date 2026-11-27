import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// The LibraOS Gateway: a Console API key (lk_…) that agentd's workers and the app's chats use for
// model access, pay as you go. The server keeps the key; clients only see whether it is connected.

export const LIBRAOS_GATEWAY_ORIGIN = "https://api.libraos.com";
export const LIBRAOS_CONSOLE_API_KEYS_URL = "https://console.libraos.com/api-keys";
/** LibraOS Cloud (Console): device sign-in (RFC 8628) and the Gateway keys a sign-in may make. */
export const LIBRAOS_CLOUD_ORIGIN = "https://console.libraos.com";
export const LIBRAOS_DEVICE_CLIENT_ID = "agentd-desktop";
/** Console's Credits page: where credits are bought when the app cannot start a checkout itself. */
export const LIBRAOS_CREDITS_URL = `${LIBRAOS_CLOUD_ORIGIN}/credits`;

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

// The Gateway's refusals: 402 `insufficient_credits` and a used-up Token Plan's 429
// `plan_limit_reached`. Each agent words the failed turn its own way; some keep the error type,
// some keep only the Gateway's message, so both are matched.
const OUT_OF_CREDITS = /\binsufficient_credits\b|LibraOS credits have run out/i;
const PLAN_LIMIT = /\bplan_limit_reached\b/i;

export type LibraosCreditsRefusal = "out-of-credits" | "plan-limit";

/** Which credit refusal a failed turn on a LibraOS Gateway agent is, or null for any other error. */
export function libraosCreditsRefusal(
  instanceId: string | null | undefined,
  error: string | null | undefined,
): LibraosCreditsRefusal | null {
  if (error == null || instanceId == null || !isLibraosGatewayInstanceId(instanceId)) return null;
  if (OUT_OF_CREDITS.test(error)) return "out-of-credits";
  if (PLAN_LIMIT.test(error)) return "plan-limit";
  return null;
}

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

/** The connected key's account balance, as Console reports it. */
export const LibraosGatewayCredits = Schema.Struct({
  availableUsd: Schema.Finite,
  /** Reserved by running work, not yet spent. */
  heldUsd: Schema.Finite,
  /** Whether model calls are refused once the balance runs out. */
  enforced: Schema.Boolean,
  /** The amounts a checkout may buy; the only ones the app offers. */
  amountsUsd: Schema.Array(Schema.Finite),
  creditsUrl: Schema.String,
  plan: Schema.NullOr(Schema.Struct({ name: Schema.String, overage: Schema.Boolean })),
});
export type LibraosGatewayCredits = typeof LibraosGatewayCredits.Type;

export const LibraosGatewayCheckoutInput = Schema.Struct({
  usd: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
});
export type LibraosGatewayCheckoutInput = typeof LibraosGatewayCheckoutInput.Type;

export const LibraosGatewayCheckout = Schema.Struct({
  /** Stripe Checkout, or Console's Credits page when Console cannot start a checkout. */
  url: Schema.String,
});
export type LibraosGatewayCheckout = typeof LibraosGatewayCheckout.Type;

/**
 * available: can be subscribed to; current: the account's plan; coming_soon: shown, not sold yet;
 * unavailable: shown, nothing to click.
 */
export const LibraosGatewayPlanState = Schema.Literals([
  "available",
  "current",
  "coming_soon",
  "unavailable",
]);
export type LibraosGatewayPlanState = typeof LibraosGatewayPlanState.Type;

/** One of Console's plans; the app never names or prices a plan itself. */
export const LibraosGatewayPlan = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  priceUsd: Schema.Finite,
  interval: Schema.Literals(["month", "year"]),
  /** Console's English summary, shown as is. */
  summary: Schema.String,
  state: LibraosGatewayPlanState,
});
export type LibraosGatewayPlan = typeof LibraosGatewayPlan.Type;

export const LibraosGatewayPlans = Schema.Struct({
  plans: Schema.Array(LibraosGatewayPlan),
  /** The id of the account's plan, if it has one. */
  current: Schema.NullOr(Schema.String),
  /** Console's page for changing or cancelling a plan; the app never does either. */
  manageUrl: Schema.String,
});
export type LibraosGatewayPlans = typeof LibraosGatewayPlans.Type;

export const LibraosGatewayPlanCheckoutInput = Schema.Struct({
  plan: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type LibraosGatewayPlanCheckoutInput = typeof LibraosGatewayPlanCheckoutInput.Type;

export class LibraosGatewayError extends Schema.TaggedError<LibraosGatewayError>()(
  "LibraosGatewayError",
  {
    /** The Gateway's own message for a refused key, or what went wrong on this host. */
    message: Schema.String,
  },
) {}
