import {
  LIBRAOS_CREDITS_URL,
  type LibraosGatewayCheckout,
  type LibraosGatewayCredits,
  type LibraosGatewayPlan,
  type LibraosGatewayPlans,
} from "@t3tools/contracts";

import { cloudRefusal } from "./deviceSignIn.ts";

// Console's balance, plans and checkout answers for the connected key. Read here so the service only
// moves bytes. A Console without these endpoints answers 404, and a deployment without credits or
// plans 501: both are "nothing to show", not a failure.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value.trim()).protocol === "https:" ? value.trim() : null;
  } catch {
    return null;
  }
};

function parseCredits(body: unknown): LibraosGatewayCredits | null {
  if (!isRecord(body) || !isAmount(body.available_usd)) return null;
  const amounts = Array.isArray(body.amounts_usd)
    ? [...new Set(body.amounts_usd.filter((amount) => isAmount(amount) && amount > 0))]
    : [];
  const plan = body.plan;
  return {
    availableUsd: body.available_usd,
    heldUsd: isAmount(body.held_usd) ? body.held_usd : 0,
    enforced: body.enforced === true,
    amountsUsd: amounts.toSorted((a, b) => a - b),
    creditsUrl: httpsUrl(body.credits_url) ?? LIBRAOS_CREDITS_URL,
    plan:
      isRecord(plan) && typeof plan.name === "string"
        ? { name: plan.name, overage: plan.overage === true }
        : null,
  };
}

export type CreditsAnswer =
  | { readonly credits: LibraosGatewayCredits | null }
  | { readonly refusal: string };

export function readCreditsAnswer(status: number, body: unknown): CreditsAnswer {
  if (status >= 200 && status < 300) return { credits: parseCredits(body) };
  if (status === 404 || status === 501) return { credits: null };
  return { refusal: cloudRefusal(status, body, "read the balance") };
}

export type CheckoutAnswer = LibraosGatewayCheckout | { readonly refusal: string };

/**
 * Stripe Checkout's page, for credits or a plan; Console's Credits page when Console has no
 * checkout or billing is down.
 */
export function readCheckoutAnswer(status: number, body: unknown): CheckoutAnswer {
  if (status >= 200 && status < 300) {
    const url = isRecord(body) ? httpsUrl(body.url) : null;
    return url === null ? { refusal: "LibraOS answered with an unreadable checkout." } : { url };
  }
  if (status === 404 || status === 503) return { url: LIBRAOS_CREDITS_URL };
  return { refusal: cloudRefusal(status, body, "start a checkout") };
}

const PLAN_STATES: ReadonlyArray<LibraosGatewayPlan["state"]> = [
  "available",
  "current",
  "coming_soon",
  "unavailable",
];

// A plan this app cannot read is left out rather than failing the list.
function parsePlan(value: unknown): LibraosGatewayPlan | null {
  if (!isRecord(value)) return null;
  const { id, name, price_usd: price, interval, summary, state } = value;
  if (typeof id !== "string" || id.trim() === "" || typeof name !== "string") return null;
  if (!isAmount(price) || price < 0) return null;
  if (interval !== "month" && interval !== "year") return null;
  const known = PLAN_STATES.find((candidate) => candidate === state);
  return {
    id,
    name,
    priceUsd: price,
    interval,
    summary: typeof summary === "string" ? summary : "",
    state: known ?? "unavailable",
  };
}

function parsePlans(body: unknown): LibraosGatewayPlans | null {
  if (!isRecord(body) || !Array.isArray(body.plans)) return null;
  const plans = body.plans.flatMap((plan) => parsePlan(plan) ?? []);
  const current = typeof body.current === "string" && body.current !== "" ? body.current : null;
  return {
    plans,
    current,
    manageUrl: httpsUrl(body.manage_url) ?? LIBRAOS_CREDITS_URL,
  };
}

export type PlansAnswer =
  | { readonly plans: LibraosGatewayPlans | null }
  | { readonly refusal: string };

export function readPlansAnswer(status: number, body: unknown): PlansAnswer {
  if (status >= 200 && status < 300) return { plans: parsePlans(body) };
  if (status === 404 || status === 501) return { plans: null };
  return { refusal: cloudRefusal(status, body, "read the plans") };
}
