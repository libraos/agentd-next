import {
  LIBRAOS_CREDITS_URL,
  type LibraosGatewayCheckout,
  type LibraosGatewayCredits,
} from "@t3tools/contracts";

import { cloudRefusal } from "./deviceSignIn.ts";

// Console's balance and checkout answers for the connected key. Read here so the service only moves
// bytes. A Console without these endpoints answers 404, and a deployment without credits 501: both
// are "no balance", not a failure.

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

/** Stripe Checkout's page; Console's Credits page when Console has no checkout or billing is down. */
export function readCheckoutAnswer(status: number, body: unknown): CheckoutAnswer {
  if (status >= 200 && status < 300) {
    const url = isRecord(body) ? httpsUrl(body.url) : null;
    return url === null ? { refusal: "LibraOS answered with an unreadable checkout." } : { url };
  }
  if (status === 404 || status === 503) return { url: LIBRAOS_CREDITS_URL };
  return { refusal: cloudRefusal(status, body, "start a checkout") };
}
