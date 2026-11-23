import {
  AgentdDefaultBudget,
  DEFAULT_AGENTD_BUDGET,
  type AgentdRunTasksOn,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { AgentdStatusLines, useAgentdState, useCloudWorkersLinked } from "./AgentdIndicator";
import { openAgentdSetupDialog, useCanSetUpAgentd } from "./AgentdSetupDialog";
import { WorkerGatewaySettings } from "./WorkerGatewaySettings";
import { parseDefaultBudget } from "./agentdVisibility.logic";
import { budgetDollars } from "./startTask.logic";

const validBudget = Schema.is(AgentdDefaultBudget);

/** Settings → Workers: every worker choice, read by Hand to a worker for its defaults. */
export function WorkersSettings() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const { state, status } = useAgentdState(environmentId);
  const canSetUp = useCanSetUpAgentd(environmentId);
  const linked = useCloudWorkersLinked(state === "on" ? environmentId : null);
  const suggest = useClientSettings((settings) => settings.agentdSuggestWorkers);
  const runTasksOn = useClientSettings((settings) => settings.agentdRunTasksOn);
  const budget = useClientSettings((settings) => settings.agentdDefaultBudget);
  const runOnItems: Record<AgentdRunTasksOn, string> = {
    local: gt("This machine"),
    cloud: gt("Cloud Workers"),
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="workers-status" title={gt("AgentD")}>
        <div className="space-y-3 px-3 py-3 sm:px-4">
          {environmentId === null ? null : (
            <AgentdStatusLines environmentId={environmentId} state={state} status={status} />
          )}
          {state === "not-set-up" && canSetUp && environmentId !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openAgentdSetupDialog(environmentId)}
            >
              <T>Set up AgentD</T>
            </Button>
          ) : (
            <Button size="xs" variant="outline" render={<Link to="/agentd" />}>
              <T>AgentD page</T>
            </Button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection id="workers" title={gt("Workers")}>
        <SettingsRow
          id="workers-suggest"
          title={gt("Suggest workers")}
          description={
            <T>
              Offer to hand a Code thread&apos;s task to a worker when a turn runs long or you send
              a message while it runs.
            </T>
          }
          control={
            <Switch
              checked={suggest}
              onCheckedChange={(checked) =>
                void updateClientSettings({ agentdSuggestWorkers: checked })
              }
              aria-label={gt("Suggest workers")}
            />
          }
        />
        <SettingsRow
          id="workers-run-on"
          title={gt("Run tasks on")}
          description={
            linked === true ? (
              <T>Where Hand to a worker starts a task. You can change it for each task.</T>
            ) : (
              <T>
                Cloud Workers need AgentD set up and your LibraOS account linked on the AgentD page.
              </T>
            )
          }
          control={
            <Select
              value={runTasksOn}
              items={runOnItems}
              onValueChange={(value) => {
                if (value === "local" || value === "cloud")
                  void updateClientSettings({ agentdRunTasksOn: value });
              }}
            >
              <SelectTrigger aria-label={gt("Run tasks on")}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="local">{runOnItems.local}</SelectItem>
                <SelectItem value="cloud" disabled={linked !== true}>
                  {runOnItems.cloud}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <DefaultBudgetRow
          key={budget}
          budget={budget}
          dollarBudgets={status?.dollarBudgets ?? null}
        />
      </SettingsSection>
      {status?.setUp === true && environmentId !== null ? (
        <WorkerGatewaySettings environmentId={environmentId} />
      ) : null}
      <SettingsSection id="workers-cloud" title={gt("Cloud Workers")}>
        <SettingsRow
          id="workers-cloud-setup"
          title={gt("LibraOS account")}
          description={
            linked === true ? (
              <T>Your LibraOS account is linked. Its credit and key are on the AgentD page.</T>
            ) : (
              <T>
                Run tasks on LibraOS machines instead of this one. Set them up on the AgentD page.
              </T>
            )
          }
          control={
            <Button size="xs" variant="outline" render={<Link to="/agentd" hash="agentd-cloud" />}>
              {linked === true ? <T>Manage Cloud Workers</T> : <T>Set up Cloud Workers</T>}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DefaultBudgetRow({
  budget,
  dollarBudgets,
}: {
  readonly budget: string;
  /** agentd's answer for this machine; false while it has no model prices. */
  readonly dollarBudgets: boolean | null;
}) {
  const gt = useGT();
  const id = useId();
  const saved = parseDefaultBudget(budget) ?? parseDefaultBudget(DEFAULT_AGENTD_BUDGET);
  const [minutes, setMinutes] = useState(String(saved?.minutes ?? 60));
  const [dollars, setDollars] = useState(budgetDollars(saved?.dollars ?? 5));
  const next = `${minutes.trim()}m,$${dollars.trim()}`;
  const valid = validBudget(next);
  const save = () => {
    if (valid && next !== budget) void updateClientSettings({ agentdDefaultBudget: next });
  };
  return (
    <SettingsRow
      id="workers-budget"
      title={gt("Default budget")}
      description={
        !valid ? (
          <span id={`${id}-hint`}>
            <T>Enter whole minutes and a dollar amount above zero.</T>
          </span>
        ) : dollarBudgets === false ? (
          <T>
            Used when AgentD has no estimate for the task. AgentD on this machine has no model
            prices, so tasks here get only the minutes; the dollar amount applies to Cloud Workers.
          </T>
        ) : (
          <T>Used when AgentD has no estimate for the task.</T>
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Input
            aria-label={gt("Minutes")}
            aria-invalid={!valid}
            aria-describedby={valid ? undefined : `${id}-hint`}
            inputMode="numeric"
            className="w-20"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            onBlur={save}
          />
          <span className="text-muted-foreground text-xs">
            <T>min</T>
          </span>
          <Input
            aria-label={gt("Dollars")}
            aria-invalid={!valid}
            inputMode="decimal"
            className="w-20"
            value={dollars}
            onChange={(event) => setDollars(event.target.value)}
            onBlur={save}
          />
          <span className="text-muted-foreground text-xs">USD</span>
        </div>
      }
    />
  );
}
