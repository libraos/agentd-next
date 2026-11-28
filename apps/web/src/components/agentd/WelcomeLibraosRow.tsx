import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import type { ReactElement, ReactNode } from "react";

import {
  useBuyLibraosCredits,
  useLibraosCredits,
  useLibraosGateway,
  useLibraosSignIn,
} from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { T3Wordmark } from "../T3Wordmark";
import { Button } from "../ui/button";
import { BuyLibraosCreditsButton } from "./LibraosCredits";
import { formatCreditsUsd } from "./libraosCredits.logic";
import { libraosBalance, libraosConnection, libraosReadyAgents } from "./libraosAccount.logic";

/**
 * The welcome page's LibraOS row, shaped like an agent row: one more way to get models, not a
 * preferred agent. Sign in starts the browser sign-in at once; Manage leads to the Gateway screen.
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
  const gateway = useLibraosGateway(environmentId);
  const credits = useLibraosCredits(environmentId);
  const signIn = useLibraosSignIn(environmentId);
  const buying = useBuyLibraosCredits(credits.environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.settings;
  const ready = libraosReadyAgents(providers, settings, resolveProviderInstanceDisplayName);
  const connection = libraosConnection(gateway);
  const balance = libraosBalance(credits, credits.data?.plan != null);
  const link = (action: string) => (
    <Button
      className="shrink-0"
      size="xs"
      variant="outline"
      aria-label={gt("{action}: {agent}", { action, agent: "LibraOS" })}
      render={gatewayLink}
    >
      {action}
    </Button>
  );

  let lines: ReactNode;
  let action: ReactNode;
  switch (connection.kind) {
    case "checking":
      lines = <Line>{gt("Checking connection…")}</Line>;
      action = null;
      break;
    case "failed":
      lines = <Line tone="error">{connection.error}</Line>;
      action = (
        <Button className="shrink-0" size="xs" variant="outline" onClick={gateway.refresh}>
          {gt("Retry")}
        </Button>
      );
      break;
    case "signedOut":
      lines = (
        <Line>{gt("No agent to install. Use models through LibraOS Gateway, pay as you go.")}</Line>
      );
      action = (
        <Button
          className="shrink-0"
          size="xs"
          variant="outline"
          disabled={!signIn.canChange}
          aria-label={gt("{action}: {agent}", { action: gt("Sign in"), agent: "LibraOS" })}
          onClick={() => void signIn.start()}
        >
          {gt("Sign in")}
        </Button>
      );
      break;
    case "rejected":
      lines = <Line tone="error">{gt("LibraOS Gateway rejected this key")}</Line>;
      action = link(gt("Reconnect", { $context: "verb, connects the LibraOS Gateway again" }));
      break;
    case "connected": {
      const manage = link(gt("Manage", { $context: "verb, opens the LibraOS account panel" }));
      const agents =
        ready.gateway.length === 0
          ? null
          : gt("{agents} ready, nothing to install", {
              agents: new Intl.ListFormat(locale, { type: "conjunction" }).format(ready.gateway),
            });
      const money =
        balance.kind === "usedUp" ? (
          <Line tone="warning">{gt("Credits used up. Buy credits to use LibraOS Gateway.")}</Line>
        ) : balance.kind === "low" || balance.kind === "ok" ? (
          <Line tone={balance.kind === "low" ? "warning" : "muted"}>
            {gt("{available} available", {
              available: formatCreditsUsd(balance.credits.availableUsd, locale),
            })}
          </Line>
        ) : balance.kind === "reading" ? (
          <Line>{gt("Reading balance…")}</Line>
        ) : balance.kind === "failed" ? (
          <Line>{gt("Balance unavailable")}</Line>
        ) : null;
      lines = (
        <>
          <Line tone="success">
            {agents ?? gt("Connected", { $context: "LibraOS account status" })}
          </Line>
          {money}
        </>
      );
      action =
        balance.kind === "usedUp" && buying.canBuy ? (
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <BuyLibraosCreditsButton environmentId={environmentId} size="xs" />
            {manage}
          </span>
        ) : (
          manage
        );
      break;
    }
  }

  return (
    <li className="flex min-h-16 items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <T3Wordmark className="size-6 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-sm text-foreground">LibraOS</span>
        <div role="status" className="space-y-0.5">
          {lines}
        </div>
        {ready.othersReady ? (
          <Line>{gt("Agents you already use keep their own sign-in and billing.")}</Line>
        ) : null}
      </div>
      {action}
    </li>
  );
}

function Line({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "success" | "warning" | "error";
  readonly children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-xs leading-relaxed break-words",
        tone === "success"
          ? "text-success-foreground"
          : tone === "warning"
            ? "text-warning-foreground"
            : tone === "error"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
