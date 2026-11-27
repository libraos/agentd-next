import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import type { ReactNode } from "react";

import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const NO_PROJECT = "";

/** A list beside its detail; on a narrow screen the detail replaces the list, with a way back. */
export function CustomizeListDetail({
  toolbar,
  list,
  detail,
  onBack,
}: {
  readonly toolbar: ReactNode;
  readonly list: ReactNode;
  readonly detail: ReactNode | null;
  readonly onBack: () => void;
}) {
  const open = detail !== null;
  return (
    <div className="flex min-h-0 min-w-0 grow">
      <section
        className={`min-h-0 min-w-0 grow flex-col border-border md:flex md:max-w-sm md:border-e ${open ? "hidden" : "flex"}`}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {toolbar}
        </div>
        <div className="min-h-0 grow overflow-y-auto">{list}</div>
      </section>
      <section className={`min-h-0 min-w-0 grow flex-col ${open ? "flex" : "hidden md:flex"}`}>
        {open ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-2 md:hidden">
              <Button type="button" size="xs" variant="ghost" onClick={onBack}>
                <T>Back</T>
              </Button>
            </div>
            <div className="min-h-0 grow overflow-y-auto p-5">{detail}</div>
          </>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">
            <T>Choose one to see its details.</T>
          </p>
        )}
      </section>
    </div>
  );
}

/** The project whose own connectors or skills are shown; none shows the agents' user ones. */
export function CustomizeProjectPicker({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ProjectId | null;
  readonly onChange: (projectId: ProjectId | null) => void;
}) {
  const gt = useGT();
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  return (
    <Select
      value={value ?? NO_PROJECT}
      onValueChange={(next) =>
        onChange(next === null || next === NO_PROJECT ? null : (next as ProjectId))
      }
    >
      <SelectTrigger aria-label={gt("Project")} className="min-w-40" size="xs">
        <SelectValue>
          {value === null
            ? gt("No project")
            : (projects.find((project) => project.id === value)?.title ?? gt("No project"))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NO_PROJECT}>{gt("No project")}</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
