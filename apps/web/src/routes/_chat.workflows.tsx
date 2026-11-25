import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { readWorkflowPane } from "../components/workflows/workflowPane.logic";
import { WorkflowsPage, type WorkflowsSearch } from "../components/workflows/WorkflowsPage";
import { productProfile } from "../productProfile";

const sliceParam = (value: string) => value.slice(0, splitsSurrogatePair(value, 200) ? 199 : 200);

export const Route = createFileRoute("/_chat/workflows")({
  beforeLoad: () => {
    if (!productProfile.workflows) throw redirect({ to: "/", replace: true });
  },
  validateSearch: (raw: Record<string, unknown>): WorkflowsSearch => ({
    ...(typeof raw.env === "string" && raw.env ? { env: sliceParam(raw.env) } : {}),
    ...(typeof raw.run === "string" && raw.run ? { run: sliceParam(raw.run) } : {}),
    ...readWorkflowPane(raw.pane, raw.tab),
    ...(raw.definitions === true || raw.definitions === "true" ? { definitions: true } : {}),
    ...(typeof raw.file === "string" && raw.file ? { file: sliceParam(raw.file) } : {}),
  }),
  component: WorkflowsPage,
});
