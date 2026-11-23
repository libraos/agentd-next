import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentdDoctorCheck,
  AgentdWorkerGateway,
  AgentdWorkerTool,
  CustomGatewaySummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useAgentdCommands, useAgentdStatus, useAgentdWorkerGateway } from "~/lib/agentdState";
import { useCustomGateways } from "~/lib/customGatewayState";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { TASK_WORKERS } from "./startTask.logic";
import { workerGatewayLine, workerGatewayNow, workerGatewaysFor } from "./workerGateway.logic";

const OWN_LOGIN = "own-login";
const TOOLS = ["claude", "codex", "opencode"] as const satisfies ReadonlyArray<AgentdWorkerTool>;

/** Settings → Workers: the gateway and model each tool's workers on this machine use. */
export function WorkerGatewaySettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useAgentdWorkerGateway(environmentId);
  const status = useAgentdStatus(environmentId);
  const gateways = useCustomGateways(environmentId).data?.gateways ?? [];
  const current = setting.data;
  if (current === null || !current.supported) return null;
  const refresh = () => {
    setting.refresh();
    status.refresh();
  };
  return (
    <SettingsSection id="workers-gateway" title={gt("Worker gateway")}>
      {TOOLS.map((tool) => (
        <WorkerGatewayRow
          key={tool}
          tool={tool}
          environmentId={environmentId}
          setting={current}
          gateways={gateways}
          checks={status.data?.checks ?? []}
          onChanged={refresh}
        />
      ))}
    </SettingsSection>
  );
}

function WorkerGatewayRow({
  tool,
  environmentId,
  setting,
  gateways,
  checks,
  onChanged,
}: {
  readonly tool: AgentdWorkerTool;
  readonly environmentId: EnvironmentId;
  readonly setting: AgentdWorkerGateway;
  readonly gateways: ReadonlyArray<CustomGatewaySummary>;
  readonly checks: ReadonlyArray<AgentdDoctorCheck>;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const { setWorkerGateway } = useAgentdCommands();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = TASK_WORKERS[tool];
  const offered = workerGatewaysFor(tool, gateways);
  const now = workerGatewayNow(tool, setting, gateways, checks);
  const line = workerGatewayLine(tool, checks);
  const models = now?.models.filter((model) => !now.hiddenModels.includes(model)) ?? [];
  const model = setting.models[tool];
  const gatewayItems: Record<string, string> = {
    [OWN_LOGIN]: gt("{name}'s own login", { name }),
    ...Object.fromEntries(offered.map((gateway) => [gateway.id, gateway.name])),
  };

  async function choose(gateway: { id: string; model: string } | null) {
    setSaving(true);
    setFailure(null);
    const result = await setWorkerGateway({ environmentId, input: { tool, gateway } });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("AgentD did not change the setting."));
    }
    onChanged();
  }

  return (
    <SettingsRow
      id={`workers-gateway-${tool}`}
      title={name}
      description={
        failure !== null ? (
          <span role="alert" className="break-words text-destructive">
            {failure}
          </span>
        ) : now === null && line !== null ? (
          <span className="break-words">{line}</span>
        ) : offered.length === 0 ? (
          <T>No gateway in Providers speaks the format this worker needs.</T>
        ) : now === null ? (
          <T>Workers use this tool&apos;s own login and default model.</T>
        ) : (
          <T>Workers on this machine send their requests through this gateway.</T>
        )
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            value={now?.id ?? OWN_LOGIN}
            items={gatewayItems}
            disabled={saving || offered.length === 0}
            onValueChange={(value) => {
              if (value === OWN_LOGIN) return void choose(null);
              const gateway = offered.find((candidate) => candidate.id === value);
              const first = gateway?.models.find((id) => !gateway.hiddenModels.includes(id));
              if (gateway === undefined || first === undefined) {
                return setFailure(gt("That gateway has no model to use."));
              }
              void choose({ id: gateway.id, model: first });
            }}
          >
            <SelectTrigger aria-label={gt("{name} gateway", { name })}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(gatewayItems).map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {now === null ? null : (
            <Select
              value={models.includes(model) ? model : null}
              disabled={saving}
              onValueChange={(value) => {
                if (typeof value === "string") void choose({ id: now.id, model: value });
              }}
            >
              <SelectTrigger aria-label={gt("{name} model", { name })}>
                <SelectValue placeholder={gt("Model")} />
              </SelectTrigger>
              <SelectPopup>
                {models.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </div>
      }
    />
  );
}
