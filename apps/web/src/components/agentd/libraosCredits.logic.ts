import type { LibraosGatewayCredits } from "@t3tools/contracts";

/** Below this, with enforcement on, the balance is shown as a warning. */
const LOW_BALANCE_USD = 2;

export function isLowLibraosBalance(
  credits: Pick<LibraosGatewayCredits, "enforced" | "availableUsd">,
): boolean {
  return credits.enforced && credits.availableUsd < LOW_BALANCE_USD;
}

export function formatCreditsUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    ...(Number.isInteger(amount) ? { maximumFractionDigits: 0 } : {}),
  }).format(amount);
}
