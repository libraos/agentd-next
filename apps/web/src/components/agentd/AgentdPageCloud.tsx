import type { EnvironmentId } from "@t3tools/contracts";
import { T, useLocale, Var } from "gt-react";
import { useState } from "react";

import { useAgentdCloudAccount } from "../../lib/agentdState";
import { Button } from "../ui/button";
import { AgentdLoading, AgentdReadError } from "./AgentdPageReads";
import { CloudWorkersSetup } from "./CloudWorkersSetup";

/** The AgentD page's Cloud Workers account: its credit, and setting up or replacing its key. */
export function AgentdPageCloud({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const locale = useLocale();
  const account = useAgentdCloudAccount(environmentId);
  const [replacing, setReplacing] = useState(false);
  if (account.error !== null) return <AgentdReadError error={account.error} />;
  const setup = account.data;
  if (setup === null) return <AgentdLoading />;
  if (setup.unreachable === true)
    return (
      <div className="flex items-center gap-2 text-sm">
        <p role="status" className="text-muted-foreground">
          <T>Couldn’t reach AgentD.</T>
        </p>
        <Button type="button" size="xs" variant="outline" onClick={account.refresh}>
          <T>Retry</T>
        </Button>
      </div>
    );
  if (!setup.supported)
    return (
      <p className="text-sm text-muted-foreground">
        <T>This version of AgentD has no Cloud Workers.</T>
      </p>
    );
  const configured = setup.problem !== "setup";
  const balance =
    setup.balanceUsd === null
      ? null
      : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          setup.balanceUsd,
        );
  const form = (cancel?: () => void) => (
    <CloudWorkersSetup
      environmentId={environmentId}
      canConfigure={setup.canConfigure === true}
      setupUrl={setup.setupUrl}
      onConfigured={() => {
        setReplacing(false);
        account.refresh();
      }}
      onCancel={cancel}
    />
  );
  if (!configured)
    return (
      <div className="space-y-2 text-sm">
        <p>
          <T>Cloud Workers aren’t set up on this machine.</T>
        </p>
        {form()}
      </div>
    );
  return (
    <div className="space-y-2 text-sm">
      {balance !== null ? (
        <p>
          <T>
            Available LibraOS credit: <Var>{balance}</Var>
          </T>
        </p>
      ) : setup.balanceText ? (
        <p className="whitespace-pre-wrap break-words">{setup.balanceText}</p>
      ) : (
        <p className="text-muted-foreground">
          <T>LibraOS balance unavailable.</T>
        </p>
      )}
      {replacing ? (
        form(() => setReplacing(false))
      ) : setup.canConfigure ? (
        <Button type="button" size="xs" variant="outline" onClick={() => setReplacing(true)}>
          <T>Replace the account key</T>
        </Button>
      ) : null}
    </div>
  );
}
