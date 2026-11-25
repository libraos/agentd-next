import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId, type ReactElement } from "react";

import { PRIVACY_POLICY_URL } from "~/legalLinks";
import { useLibraosGatewayConnected } from "~/lib/libraosGatewayState";
import { Button } from "../ui/button";
import { openAgentdSetupDialog, useCanSetUpAgentd } from "./AgentdSetupDialog";

/** The welcome page's two ways in; choosing one stores nothing and hides nothing. */
export function WelcomeAccountCards({
  environmentId,
  agentsId,
  gatewayLink,
}: {
  readonly environmentId: EnvironmentId;
  /** The agent list's element id, which Bring your own key leads to. */
  readonly agentsId: string;
  /** A link to the Gateway screen, rendered as the LibraOS account card's button. */
  readonly gatewayLink: ReactElement;
}) {
  const gt = useGT();
  const byokId = useId();
  const libraosId = useId();
  const gatewayConnected = useLibraosGatewayConnected(environmentId);
  const canSetUp = useCanSetUpAgentd(environmentId);
  const usageLink = (
    <a
      className="text-xs text-muted-foreground underline decoration-current/40 underline-offset-2 hover:text-foreground"
      href={PRIVACY_POLICY_URL}
      target="_blank"
      rel="noreferrer noopener"
    >
      <T>Product usage data</T>
    </a>
  );
  return (
    <section aria-label={gt("How to connect")} className="mb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 id={byokId} className="font-semibold text-sm">
            <T>Bring your own key</T>
          </h2>
          <p className="flex-1 text-muted-foreground text-xs">
            <T>
              Use agent subscriptions or API keys you already have. Your provider bills you. Work
              runs on this machine.
            </T>
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button
              size="xs"
              variant="outline"
              aria-describedby={byokId}
              onClick={() => {
                const agents = document.getElementById(agentsId);
                agents?.scrollIntoView({ block: "start" });
                agents?.focus({ preventScroll: true });
              }}
            >
              <T>Choose an agent</T>
            </Button>
            {usageLink}
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 id={libraosId} className="font-semibold text-sm">
            <T>LibraOS account</T>
          </h2>
          <p className="flex-1 text-muted-foreground text-xs">
            <T>
              One account for models (LibraOS Gateway) and for workers that run in the cloud (Cloud
              Workers). LibraOS bills you.
            </T>
          </p>
          {gatewayConnected ? (
            <div className="space-y-1 text-xs">
              <p className="font-medium">
                <T>Gateway connected</T>
              </p>
              {canSetUp ? (
                <Button
                  size="xs"
                  variant="link"
                  onClick={() => openAgentdSetupDialog(environmentId)}
                >
                  <T>Cloud Workers: set up LibraOS Engine to use them</T>
                </Button>
              ) : (
                <p className="text-muted-foreground">
                  <T>Cloud Workers: set up LibraOS Engine to use them</T>
                </p>
              )}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button size="xs" variant="outline" aria-describedby={libraosId} render={gatewayLink}>
              {gatewayConnected ? <T>Gateway settings</T> : <T>Use a LibraOS account</T>}
            </Button>
            {usageLink}
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-muted-foreground text-xs">
        <T>You can use both, and change this later in Settings.</T>
      </p>
    </section>
  );
}
