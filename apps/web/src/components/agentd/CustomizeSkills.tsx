import { useAtomValue } from "@effect/atom-react";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import {
  agentdEnvironment,
  useAgentdCustomizeCommands,
  useAgentdSkillDetail,
} from "../../lib/agentdState";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useProviderWorkspaceSnapshotRefresh } from "../chat/useProviderWorkspaceSnapshotRefresh";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { AgentdLoading, AgentdReadError } from "./AgentdPageReads";
import { CustomizeListDetail, CustomizeProjectPicker } from "./CustomizeLayout";

interface Selected {
  readonly instanceId: ProviderInstanceId;
  readonly path: string;
}

/** Each agent's skills as it reports them, with the chosen project's own; read one and switch it. */
export function CustomizeSkills({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const providers = (useEnvironmentProviders().get(environmentId) ?? []).filter(
    (provider) => provider.enabled && provider.installed,
  );
  const cwd =
    useProjects().find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    )?.workspaceRoot ?? null;
  const chosenProvider =
    selected === null
      ? undefined
      : providers.find((provider) => provider.instanceId === selected.instanceId);
  const chosenSkill =
    chosenProvider === undefined || selected === null
      ? undefined
      : resolveProviderSkillsForCwd(chosenProvider, cwd).find(
          (skill) => skill.path === selected.path,
        );

  return (
    <CustomizeListDetail
      toolbar={
        <CustomizeProjectPicker
          environmentId={environmentId}
          value={projectId}
          onChange={(next) => {
            setProjectId(next);
            setSelected(null);
          }}
        />
      }
      list={
        <div className="grid gap-4 p-4">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No agents are set up on this environment.</T>
            </p>
          ) : null}
          {providers.map((provider) => (
            <AgentSkills
              key={provider.instanceId}
              environmentId={environmentId}
              provider={provider}
              cwd={cwd}
              selected={selected}
              onOpen={(path) => setSelected({ instanceId: provider.instanceId, path })}
            />
          ))}
        </div>
      }
      detail={
        chosenProvider === undefined || chosenSkill === undefined ? null : (
          <SkillDetail
            key={`${chosenProvider.instanceId}:${chosenSkill.path}`}
            environmentId={environmentId}
            instanceId={chosenProvider.instanceId}
            skill={chosenSkill}
            projectId={projectId}
          />
        )
      }
      onBack={() => setSelected(null)}
    />
  );
}

function AgentSkills({
  environmentId,
  provider,
  cwd,
  selected,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly cwd: string | null;
  readonly selected: Selected | null;
  readonly onOpen: (path: string) => void;
}) {
  const { scanning } = useProviderWorkspaceSnapshotRefresh({
    environmentId,
    gitCwd: cwd,
    instanceId: provider.instanceId,
  });
  const skills = [...resolveProviderSkillsForCwd(provider, cwd)].toSorted((a, b) =>
    (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
  );
  return (
    <section className="grid gap-1">
      <h2 className="text-xs font-medium text-muted-foreground uppercase">
        {provider.displayName ?? provider.instanceId}
      </h2>
      {scanning ? <AgentdLoading /> : null}
      {!scanning && skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No skills.</T>
        </p>
      ) : null}
      <ul className="grid gap-0.5">
        {skills.map((skill) => {
          const current =
            selected?.instanceId === provider.instanceId && selected.path === skill.path;
          return (
            <li key={skill.path}>
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent ${current ? "bg-accent" : ""}`}
                onClick={() => onOpen(skill.path)}
              >
                <span className="min-w-0 grow truncate font-medium">
                  {skill.displayName ?? skill.name}
                </span>
                {skill.scope !== undefined ? <Badge variant="outline">{skill.scope}</Badge> : null}
                {skill.enabled ? null : (
                  <Badge variant="secondary">
                    <T>Off</T>
                  </Badge>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SkillDetail({
  environmentId,
  instanceId,
  skill,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly skill: ServerProviderSkill;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const ref = { instanceId, path: skill.path, ...(projectId === null ? {} : { projectId }) };
  const commands = useAgentdCustomizeCommands();
  // Reading a skill's file needs the same maintain access as switching it.
  const canChange = useAtomValue(agentdEnvironment.skillSetEnabled.permissionAtom(environmentId));
  const detail = useAgentdSkillDetail(environmentId, canChange ? ref : null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The provider's list catches up on its next scan; until then show what was written.
  const [enabled, setEnabled] = useState(skill.enabled);
  const data = detail.data;
  // A project switch needs a project; with none chosen only a user-wide switch can be written.
  const switchable =
    data !== null && (data.toggle === "user" || (data.toggle === "project" && projectId !== null));

  return (
    <div className="grid gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{skill.displayName ?? skill.name}</h2>
        <Switch
          className="ms-auto"
          checked={enabled}
          disabled={!canChange || !switchable || busy}
          aria-label={gt("Turn {name} on", { name: skill.name })}
          onCheckedChange={async (checked) => {
            setBusy(true);
            setFailure(null);
            const result = await commands.skillSetEnabled({
              environmentId,
              input: { ...ref, enabled: Boolean(checked) },
            });
            setBusy(false);
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              setFailure(error instanceof Error ? error.message : gt("The skill was not changed."));
            } else {
              setEnabled(Boolean(checked));
            }
            detail.refresh();
          }}
        />
      </div>
      {skill.description !== undefined ? (
        <p className="text-muted-foreground">{skill.description}</p>
      ) : null}
      <p className="font-mono text-xs text-muted-foreground wrap-anywhere">{skill.path}</p>
      {failure !== null ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
      {!canChange ? (
        <p className="text-xs text-muted-foreground">
          <T>Reading and switching skills requires maintain access to this environment.</T>
        </p>
      ) : detail.error !== null ? (
        <AgentdReadError error={detail.error} />
      ) : data === null ? (
        <AgentdLoading />
      ) : (
        <>
          {data.lockedReason !== undefined ? (
            <p className="text-xs text-muted-foreground">{data.lockedReason}</p>
          ) : data.toggle === "project" && projectId === null ? (
            <p className="text-xs text-muted-foreground">
              <T>Choose a project to switch this skill; this agent switches skills per project.</T>
            </p>
          ) : null}
          {data.settingsFile !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {gt("Decided in {file}", { file: data.settingsFile })}
            </p>
          ) : null}
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
            {data.body}
          </pre>
          {data.truncated ? (
            <p className="text-xs text-muted-foreground">
              <T>The file is longer; only its start is shown.</T>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
