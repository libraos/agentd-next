import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";
import { useId } from "react";

import { useLibraosCredits, useLibraosPlans } from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BuyLibraosCreditsButton } from "./LibraosCredits";
import { formatCreditsUsd, isLowLibraosBalance } from "./libraosCredits.logic";
import { LibraosPlansPanel } from "./LibraosPlans";

/**
 * Settings → Providers' LibraOS card: one line with the balance and plan, Buy credits and Plans
 * each opening its list beside it. Signed out, one line and Sign in.
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
  const credits = useLibraosCredits(environmentId);
  const plans = useLibraosPlans(environmentId);
  if (environmentId === null) return null;
  const creditsSetting = searchableSetting("libraos-credits");
  const plansSetting = searchableSetting("libraos-plans");
  const balance = credits.data;
  const plan =
    balance?.plan?.name ??
    plans.data?.plans.find((entry) => entry.id === plans.data?.current || entry.state === "current")
      ?.name ??
    null;
  const available = balance === null ? null : formatCreditsUsd(balance.availableUsd, locale);
  const line = !credits.connected
    ? gt("Every model on one account, pay as you go.")
    : available === null
      ? plan === null
        ? gt("Connected · No plan")
        : gt("Connected · Plan: {plan}", { plan })
      : plan === null
        ? gt("{available} available · No plan", { available })
        : gt("{available} available · Plan: {plan}", { available, plan });
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
          className={cn(
            "text-xs",
            balance !== null && isLowLibraosBalance(balance)
              ? "text-warning-foreground"
              : "text-muted-foreground",
          )}
        >
          {line}
        </p>
      </div>
      {credits.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <BuyLibraosCreditsButton environmentId={environmentId} variant="outline" />
          <Popover>
            <PopoverTrigger id={plansSetting.id} render={<Button size="sm" variant="outline" />}>
              <T>Plans</T>
            </PopoverTrigger>
            <PopoverPopup align="end" width="lg" aria-label={plansSetting.title}>
              <LibraosPlansPanel environmentId={environmentId} heading={false} />
            </PopoverPopup>
          </Popover>
        </div>
      ) : (
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
          <T>Sign in</T>
        </Button>
      )}
    </section>
  );
}
