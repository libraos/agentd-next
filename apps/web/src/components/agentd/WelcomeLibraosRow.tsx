import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import type { ReactElement } from "react";

import { useLibraosCredits } from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { T3Wordmark } from "../T3Wordmark";
import { Button } from "../ui/button";
import { formatCreditsUsd, isLowLibraosBalance } from "./libraosCredits.logic";

/**
 * The welcome page's LibraOS row, shaped like an agent row: one more way to get models, not a
 * preferred agent. Its button leads to the Gateway screen, to sign in or to manage the account.
 */
export function WelcomeLibraosRow({
  environmentId,
  gatewayLink,
}: {
  readonly environmentId: EnvironmentId;
  readonly gatewayLink: ReactElement;
}) {
  const gt = useGT();
  const locale = useLocale();
  const credits = useLibraosCredits(environmentId);
  const data = credits.data;
  const detail = !credits.connected
    ? gt("No agent to install. Every model on one account, pay as you go.")
    : data === null
      ? gt("Connected", { $context: "LibraOS account status" })
      : gt("Connected · {available} available", {
          available: formatCreditsUsd(data.availableUsd, locale),
        });
  const action = credits.connected
    ? gt("Manage", { $context: "verb, opens the LibraOS account panel" })
    : gt("Sign in");
  return (
    <li className="flex min-h-16 items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <T3Wordmark className="size-6 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-sm text-foreground">LibraOS</span>
        <p
          className={cn(
            "line-clamp-2 text-xs leading-relaxed break-words",
            !credits.connected
              ? "text-muted-foreground"
              : data !== null && isLowLibraosBalance(data)
                ? "text-warning-foreground"
                : "text-success-foreground",
          )}
        >
          {detail}
        </p>
      </div>
      <Button
        className="shrink-0"
        size="xs"
        variant="outline"
        aria-label={gt("{action}: {agent}", { action, agent: "LibraOS" })}
        render={gatewayLink}
      >
        {action}
      </Button>
    </li>
  );
}
