import {
  LIBRAOS_CREDITS_URL,
  type EnvironmentId,
  type LibraosGatewayPlan,
} from "@t3tools/contracts";
import { T, useGT, useLocale } from "gt-react";
import { useId } from "react";

import { useLibraosPlans, useSubscribeLibraosPlan } from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ExternalLink } from "./LibraosCredits";
import { formatCreditsUsd } from "./libraosCredits.logic";

/**
 * Console's plans, one card each, with Subscribe for those that can be bought. Names, prices and
 * summaries are Console's. With no plans to show (an older Console) it is a single See plans link.
 */
export function LibraosPlansPanel({
  environmentId: target,
  heading = true,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
  /** Off where the card around it already says Plans. */
  readonly heading?: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const plans = useLibraosPlans(target);
  const subscribing = useSubscribeLibraosPlan(plans.environmentId);
  const data = plans.data;

  if (data === null || data.plans.length === 0) {
    if (plans.isPending) return null;
    return (
      <div className="space-y-1 text-sm">
        {plans.error === null ? null : <p className="text-muted-foreground">{plans.error}</p>}
        <p>
          <ExternalLink href={LIBRAOS_CREDITS_URL}>{gt("See plans")}</ExternalLink>
        </p>
      </div>
    );
  }

  const price = (plan: LibraosGatewayPlan) => {
    const amount = formatCreditsUsd(plan.priceUsd, locale);
    return plan.interval === "year"
      ? gt("{price} per year", { price: amount })
      : gt("{price} per month", { price: amount });
  };
  const hasCurrent = data.current !== null || data.plans.some((plan) => plan.state === "current");
  return (
    <section className="space-y-2 text-sm" aria-label={gt("Plans")}>
      {heading ? (
        <h4 className="font-medium text-foreground">
          <T>Plans</T>
        </h4>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
        {data.plans.map((plan, index) => (
          <li
            key={plan.id}
            aria-labelledby={`${id}-plan-${index}`}
            className={cn(
              "flex flex-col gap-1 rounded-lg border px-3 py-2",
              plan.state === "current" ? "border-primary/40" : "border-border",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <p
                id={`${id}-plan-${index}`}
                className={cn(
                  "font-medium",
                  plan.state === "unavailable" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {plan.name}
              </p>
              <p className="text-xs text-muted-foreground">{price(plan)}</p>
            </div>
            {plan.summary ? <p className="text-xs text-muted-foreground">{plan.summary}</p> : null}
            <PlanAction
              plan={plan}
              disabled={!subscribing.canSubscribe || subscribing.subscribing !== null}
              opening={subscribing.subscribing === plan.id}
              onSubscribe={() => void subscribing.subscribe(plan.id)}
            />
          </li>
        ))}
      </ul>
      {subscribing.opened === null ? null : (
        <p role="status" className="text-muted-foreground">
          <T>Finish subscribing in your browser; your plan updates when you come back.</T>{" "}
          <ExternalLink href={subscribing.opened}>{gt("Open the checkout page")}</ExternalLink>
        </p>
      )}
      {subscribing.error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {subscribing.error} <ExternalLink href={data.manageUrl}>{gt("See plans")}</ExternalLink>
        </p>
      )}
      {hasCurrent ? (
        <p className="text-muted-foreground">
          <ExternalLink href={data.manageUrl}>{gt("Manage plan")}</ExternalLink>
        </p>
      ) : null}
    </section>
  );
}

function PlanAction({
  plan,
  disabled,
  opening,
  onSubscribe,
}: {
  readonly plan: LibraosGatewayPlan;
  readonly disabled: boolean;
  readonly opening: boolean;
  readonly onSubscribe: () => void;
}) {
  const gt = useGT();
  switch (plan.state) {
    case "available":
      return (
        <div className="mt-auto pt-1">
          <Button size="sm" variant="outline" disabled={disabled} onClick={onSubscribe}>
            {opening ? gt("Opening checkout…") : gt("Subscribe")}
          </Button>
        </div>
      );
    case "current":
      return (
        <div className="mt-auto pt-1">
          <Badge variant="success">
            <T>Current plan</T>
          </Badge>
        </div>
      );
    case "coming_soon":
      return (
        <div className="mt-auto pt-1">
          <Badge variant="secondary">
            <T>Coming soon</T>
          </Badge>
        </div>
      );
    case "unavailable":
      return null;
  }
}

/** See plans that opens Console's plans beside it; nothing while Console has none to show. */
export function SeeLibraosPlansButton({
  environmentId,
  variant = "outline",
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly variant?: "default" | "outline";
}) {
  const gt = useGT();
  const plans = useLibraosPlans(environmentId);
  if (plans.data === null || plans.data.plans.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant={variant} />}>
        <T>See plans</T>
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" aria-label={gt("LibraOS plans")}>
        <LibraosPlansPanel environmentId={plans.environmentId} />
      </PopoverPopup>
    </Popover>
  );
}

/** Settings' card for Console's plans; nothing while the Gateway is not connected. */
export function LibraosPlansSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const searchableSetting = useSearchableSetting();
  const plans = useLibraosPlans(environmentId);
  if (!plans.connected) return null;
  const setting = searchableSetting("libraos-plans");
  return (
    <section
      id={setting.id}
      aria-label={setting.title}
      className="space-y-2 rounded-lg border border-border bg-card px-4 py-3"
    >
      <h3 className="text-sm font-medium text-foreground">
        <T>LibraOS Gateway plans</T>
      </h3>
      <LibraosPlansPanel environmentId={plans.environmentId} heading={false} />
    </section>
  );
}

/** Console's plans under the Usage page's Gateway balance; nothing while it is not connected. */
export function LibraosPlansUsageSection() {
  const gt = useGT();
  const plans = useLibraosPlans();
  if (!plans.connected) return null;
  return (
    <section
      aria-label={gt("LibraOS Gateway plans")}
      className="rounded-lg border border-border px-4 py-3"
    >
      <LibraosPlansPanel environmentId={plans.environmentId} />
    </section>
  );
}
