import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";
import { useId, type ReactNode } from "react";

import {
  useLibraosCredits,
  useLibraosGateway,
  useLibraosPlans,
  useLibraosSignIn,
} from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BuyLibraosCreditsButton } from "./LibraosCredits";
import { formatCreditsUsd } from "./libraosCredits.logic";
import { libraosBalance, libraosConnection, libraosPlan } from "./libraosAccount.logic";
import { LibraosPlansPanel } from "./LibraosPlans";

/**
 * Settings → Providers' LibraOS card: one line with the balance and plan, Buy credits and Plans
 * each opening its list beside it. Signed out, one line and Sign in, which starts the sign-in.
 * Nothing it has not read is stated: a read still out or failed says so.
 */
export function LibraosAccountCard({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const gt = useGT();
  const locale = useLocale();
  const headingId = useId();
  const searchableSetting = useSearchableSetting();
  const gateway = useLibraosGateway(environmentId);
  const credits = useLibraosCredits(environmentId);
  const plans = useLibraosPlans(environmentId);
  const signIn = useLibraosSignIn(environmentId);
  if (environmentId === null) return null;
  const creditsSetting = searchableSetting("libraos-credits");
  const plansSetting = searchableSetting("libraos-plans");
  const connection = libraosConnection(gateway);
  const plan = libraosPlan(credits.data, plans);
  const balance = libraosBalance(credits, plan.kind === "named");
  const retryReads = () => {
    if (balance.kind === "failed") credits.refresh();
    if (plan.kind === "failed") plans.refresh();
  };

  let line: ReactNode;
  let warn = false;
  let actions: ReactNode;
  switch (connection.kind) {
    case "checking":
      line = gt("Checking connection…");
      actions = null;
      break;
    case "failed":
      line = connection.error;
      warn = true;
      actions = (
        <Button size="sm" variant="outline" onClick={gateway.refresh}>
          <T>Retry</T>
        </Button>
      );
      break;
    case "signedOut":
      line = gt("Use models through LibraOS Gateway, pay as you go.");
      actions = (
        <Button
          size="sm"
          variant="outline"
          disabled={!signIn.canChange}
          onClick={() => void signIn.start()}
        >
          <T>Sign in</T>
        </Button>
      );
      break;
    case "rejected":
      line = gt("LibraOS Gateway rejected this key");
      warn = true;
      actions = (
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/settings/providers"
              search={(search) => ({ ...search, setupEndpoint: "gateway" as const })}
            />
          }
        >
          {gt("Reconnect", { $context: "verb, connects the LibraOS Gateway again" })}
        </Button>
      );
      break;
    case "connected": {
      const parts = [
        balance.kind === "usedUp"
          ? gt("Credits used up. Buy credits to use LibraOS Gateway.")
          : balance.kind === "low" || balance.kind === "ok"
            ? gt("{available} available", {
                available: formatCreditsUsd(balance.credits.availableUsd, locale),
              })
            : balance.kind === "reading"
              ? gt("Reading balance…")
              : balance.kind === "failed"
                ? gt("Balance unavailable")
                : null,
        plan.kind === "named"
          ? gt("Plan: {plan}", { plan: plan.name })
          : plan.kind === "none"
            ? gt("No plan")
            : plan.kind === "reading"
              ? gt("Reading plan…")
              : gt("Plan unavailable"),
      ].filter((part) => part !== null);
      const failed = balance.kind === "failed" || plan.kind === "failed";
      warn = balance.kind === "usedUp" || balance.kind === "low";
      line = (
        <>
          {parts.join(" · ")}
          {failed ? (
            <>
              {" · "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-foreground"
                onClick={retryReads}
              >
                <T>Retry</T>
              </button>
            </>
          ) : null}
        </>
      );
      actions = (
        <div className="flex flex-wrap items-center gap-2">
          <BuyLibraosCreditsButton
            environmentId={environmentId}
            variant={balance.kind === "usedUp" ? "default" : "outline"}
          />
          <Popover>
            <PopoverTrigger id={plansSetting.id} render={<Button size="sm" variant="outline" />}>
              <T>Plans</T>
            </PopoverTrigger>
            <PopoverPopup align="end" width="lg" aria-label={plansSetting.title}>
              <LibraosPlansPanel environmentId={environmentId} heading={false} />
            </PopoverPopup>
          </Popover>
        </div>
      );
      break;
    }
  }

  return (
    <section
      id={creditsSetting.id}
      aria-labelledby={headingId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
    >
      <div className="min-w-0 space-y-0.5">
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          LibraOS
        </h2>
        <p
          role="status"
          className={cn("text-xs", warn ? "text-warning-foreground" : "text-muted-foreground")}
        >
          {line}
        </p>
      </div>
      {actions}
    </section>
  );
}
