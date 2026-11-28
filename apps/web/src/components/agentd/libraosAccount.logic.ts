import {
  isLibraosGatewayInstanceId,
  type LibraosGatewayCredits,
  type LibraosGatewayPlans,
  type LibraosGatewayStatus,
  type ServerProvider,
} from "@t3tools/contracts";

import { welcomeAgentState } from "../../onboarding/welcomePage.logic";
import { isLowLibraosBalance } from "./libraosCredits.logic";

/** What the welcome row and the Settings card know of a read: never a guess while it is not in. */
interface Read<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isSuccess: boolean;
}

export type LibraosConnection =
  | { readonly kind: "checking" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "signedOut" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "connected" };

/** The Gateway as the server last reported it; a stored key the Gateway refuses is not connected. */
export function libraosConnection(
  status: Read<Pick<LibraosGatewayStatus, "connected" | "refusal">>,
): LibraosConnection {
  const data = status.data;
  if (data === null) {
    return status.error === null ? { kind: "checking" } : { kind: "failed", error: status.error };
  }
  if (!data.connected) return { kind: "signedOut" };
  return data.refusal ? { kind: "rejected", reason: data.refusal } : { kind: "connected" };
}

export type LibraosBalance =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly error: string }
  /** Console gives no balance for this account. */
  | { readonly kind: "none" }
  | {
      readonly kind: "usedUp" | "low" | "ok";
      readonly credits: LibraosGatewayCredits;
    };

/**
 * The balance, and whether it stops Gateway agents: used up at zero with enforcement on and no
 * plan paying for use; low below a few dollars. A plan holder at zero is not warned.
 */
export function libraosBalance(
  credits: Read<LibraosGatewayCredits>,
  onPlan: boolean,
): LibraosBalance {
  const data = credits.data;
  if (data === null) {
    if (credits.isSuccess) return { kind: "none" };
    return credits.error === null ? { kind: "reading" } : { kind: "failed", error: credits.error };
  }
  if (!data.enforced) return { kind: "ok", credits: data };
  if (data.availableUsd <= 0) return { kind: onPlan ? "ok" : "usedUp", credits: data };
  return { kind: isLowLibraosBalance(data) ? "low" : "ok", credits: data };
}

export type LibraosPlan =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "none" }
  | { readonly kind: "named"; readonly name: string };

/**
 * The account's plan: named by the balance or by Console's plans, "none" only once the plans read
 * says so (an older Console with no plans sells none). A current plan with no name keeps its id.
 */
export function libraosPlan(
  balance: Pick<LibraosGatewayCredits, "plan"> | null,
  plans: Read<LibraosGatewayPlans>,
): LibraosPlan {
  if (balance?.plan) return { kind: "named", name: balance.plan.name };
  const data = plans.data;
  if (data === null) {
    if (plans.isSuccess) return { kind: "none" };
    return plans.error === null ? { kind: "reading" } : { kind: "failed", error: plans.error };
  }
  const current = data.plans.find((plan) => plan.id === data.current || plan.state === "current");
  if (current !== undefined) return { kind: "named", name: current.name };
  return data.current === null ? { kind: "none" } : { kind: "named", name: data.current };
}

export type LibraosPlansList =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "empty" }
  | { readonly kind: "listed"; readonly plans: LibraosGatewayPlans };

/** The Plans popover's contents: empty once Console confirms it sells none. */
export function libraosPlansList(plans: Read<LibraosGatewayPlans>): LibraosPlansList {
  const data = plans.data;
  if (data !== null)
    return data.plans.length === 0 ? { kind: "empty" } : { kind: "listed", plans: data };
  if (plans.isSuccess) return { kind: "empty" };
  return plans.error === null ? { kind: "reading" } : { kind: "failed", error: plans.error };
}

/**
 * The built-in Gateway's agents that are ready, by name, and whether any other agent is: those keep
 * their own sign-in and billing.
 */
export function libraosReadyAgents(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  settings: Parameters<typeof welcomeAgentState>[1],
  nameOf: (provider: ServerProvider) => string,
) {
  const gateway: string[] = [];
  let othersReady = false;
  for (const provider of providers ?? []) {
    if (welcomeAgentState(provider, settings) !== "ready") continue;
    if (isLibraosGatewayInstanceId(provider.instanceId)) gateway.push(nameOf(provider));
    else othersReady = true;
  }
  return { gateway: gateway.toSorted((a, b) => a.localeCompare(b)), othersReady };
}
