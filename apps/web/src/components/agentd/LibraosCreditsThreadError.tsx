import type { EnvironmentId, LibraosCreditsRefusal } from "@t3tools/contracts";
import { T, useGT, useLocale } from "gt-react";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { useLibraosCredits } from "../../lib/libraosGatewayState";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { BuyLibraosCreditsButton } from "./LibraosCredits";
import { SeeLibraosPlansButton } from "./LibraosPlans";
import { formatCreditsUsd } from "./libraosCredits.logic";

/**
 * Takes the generic error banner's place when a Gateway turn is refused for credit: Buy credits,
 * See plans when Console sells any, and Retry when the failed run can be resumed (agents without
 * native resume cannot).
 */
export function LibraosCreditsThreadError({
  environmentId,
  refusal,
  provider,
  onRetry,
  retrying,
  onDismiss,
}: {
  readonly environmentId: EnvironmentId;
  readonly refusal: LibraosCreditsRefusal;
  readonly provider: string | null;
  readonly onRetry: (() => void) | null;
  readonly retrying: boolean;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const credits = useLibraosCredits(environmentId);
  const data = credits.data;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="warning" surface="glass" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          {provider ? <p className="font-medium">{provider}</p> : null}
          <p className="font-medium">
            {refusal === "out-of-credits" ? (
              <T>Your LibraOS credits have run out.</T>
            ) : (
              <T>Your Token Plan is used up.</T>
            )}
          </p>
          <p>
            {refusal === "plan-limit"
              ? gt("Buy credits to keep working until the plan renews.")
              : onRetry === null
                ? gt("Buy credits, then send a message to continue.")
                : gt("Buy credits, then retry to continue where the agent stopped.")}
          </p>
          {data === null ? null : (
            <p className="text-muted-foreground">
              {gt("{available} available", {
                available: formatCreditsUsd(data.availableUsd, locale),
              })}
            </p>
          )}
        </AlertDescription>
        <AlertAction>
          <BuyLibraosCreditsButton environmentId={environmentId} />
          <SeeLibraosPlansButton environmentId={environmentId} />
          {onRetry === null ? null : (
            <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
              <T>Retry</T>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Dismiss error")}
            onClick={onDismiss}
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
