import { LIBRAOS_CREDITS_URL, type EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useLocale, Var } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useId } from "react";

import { useBuyLibraosCredits, useLibraosCredits } from "../../lib/libraosGatewayState";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { libraosBalance } from "./libraosAccount.logic";
import { formatCreditsUsd, isLowLibraosBalance } from "./libraosCredits.logic";

export function ExternalLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-4"
    >
      {children}
    </a>
  );
}

/**
 * The connected key's balance, Console's amounts to buy, and Manage billing. With no balance to
 * show (an older Console, or nothing connected) it is a single Buy credits link to Console.
 */
export function LibraosCreditsPanel({
  environmentId: target,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const credits = useLibraosCredits(target);
  const buying = useBuyLibraosCredits(credits.environmentId);
  const data = credits.data;
  const money = (amount: number) => formatCreditsUsd(amount, locale);

  if (data === null) {
    if (credits.isPending) return null;
    return (
      <div className="space-y-1 text-sm">
        {credits.error === null ? null : <p className="text-muted-foreground">{credits.error}</p>}
        <p>
          <ExternalLink href={LIBRAOS_CREDITS_URL}>{gt("Buy credits")}</ExternalLink>
        </p>
      </div>
    );
  }

  const level = libraosBalance(credits, data.plan !== null).kind;
  const low = level === "low" || level === "usedUp";
  return (
    <div className="space-y-2 text-sm" aria-labelledby={`${id}-balance`}>
      <div className="flex flex-wrap items-center gap-x-2">
        <p
          id={`${id}-balance`}
          className={cn("font-medium", low ? "text-warning-foreground" : "text-foreground")}
        >
          {data.heldUsd > 0
            ? gt("{available} available, {held} held by running work", {
                available: money(data.availableUsd),
                held: money(data.heldUsd),
              })
            : gt("{available} available", { available: money(data.availableUsd) })}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Refresh balance")}
          disabled={credits.isPending}
          onClick={credits.refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      {level === "usedUp" ? (
        <p className="text-warning-foreground">
          <T>Credits used up. Buy credits to use LibraOS Gateway.</T>
        </p>
      ) : level === "low" ? (
        <p className="text-warning-foreground">
          <T>Your LibraOS credits are almost used up. Gateway agents stop when they run out.</T>
        </p>
      ) : null}
      {data.amountsUsd.length > 0 ? (
        <div role="group" aria-label={gt("Buy credits")} className="flex flex-wrap gap-2">
          {data.amountsUsd.map((usd) => (
            <Button
              key={usd}
              size="sm"
              variant="outline"
              disabled={!buying.canBuy || buying.buying !== null}
              onClick={() => void buying.buy(usd)}
            >
              {buying.buying === usd
                ? gt("Opening checkout…")
                : gt("Buy {amount}", { amount: money(usd) })}
            </Button>
          ))}
        </div>
      ) : null}
      {buying.opened === null ? null : (
        <p role="status" className="text-muted-foreground">
          <T>Finish paying in your browser; the balance updates when you come back.</T>{" "}
          <ExternalLink href={buying.opened}>{gt("Open the checkout page")}</ExternalLink>
        </p>
      )}
      {buying.error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {buying.error}{" "}
          <ExternalLink href={data.creditsUrl}>{gt("Buy on the Credits page")}</ExternalLink>
        </p>
      )}
      <p className="text-muted-foreground">
        <ExternalLink href={data.creditsUrl}>{gt("Manage billing")}</ExternalLink>
      </p>
    </div>
  );
}

/** Buy credits that opens the amounts beside it, or Console's Credits page with none to offer. */
export function BuyLibraosCreditsButton({
  environmentId,
  variant = "default",
  size = "sm",
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly variant?: "default" | "outline";
  readonly size?: "sm" | "xs";
}) {
  const gt = useGT();
  const credits = useLibraosCredits(environmentId);
  if (credits.data === null || credits.data.amountsUsd.length === 0) {
    return (
      <Button
        size={size}
        variant={variant}
        render={
          <a
            href={credits.data?.creditsUrl ?? LIBRAOS_CREDITS_URL}
            target="_blank"
            rel="noreferrer noopener"
          />
        }
      >
        <T>Buy credits</T>
      </Button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger render={<Button size={size} variant={variant} />}>
        <T>Buy credits</T>
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" aria-label={gt("Buy LibraOS credits")}>
        <LibraosCreditsPanel environmentId={credits.environmentId} />
      </PopoverPopup>
    </Popover>
  );
}

/** The Gateway's balance as one row of the Usage page's limits; nothing while it is not connected. */
export function LibraosCreditsUsageRow() {
  const gt = useGT();
  const locale = useLocale();
  const credits = useLibraosCredits();
  if (!credits.connected) return null;
  const data = credits.data;
  return (
    <section
      aria-label={gt("LibraOS Gateway balance")}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">
          <T>LibraOS Gateway</T>
        </p>
        <p
          className={cn(
            "text-xs",
            data !== null && isLowLibraosBalance(data)
              ? "text-warning-foreground"
              : "text-muted-foreground",
          )}
        >
          {data === null ? null : (
            <T>
              <Var>{formatCreditsUsd(data.availableUsd, locale)}</Var> available
            </T>
          )}
        </p>
      </div>
      <BuyLibraosCreditsButton environmentId={credits.environmentId} variant="outline" />
    </section>
  );
}
