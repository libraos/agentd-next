import type { AgentdApproval, AgentdError, AgentdStatus, AgentdTaskRow } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** A read that has not answered yet, failed, or answered. */
type Read<A> = A | "loading" | "error";

export interface EngineScreenInput {
  /** agentd's own refusal (not installed, not set up) is passed as the error it answered with. */
  readonly status: Read<AgentdStatus> | AgentdError;
  readonly tasks: Read<readonly AgentdTaskRow[]>;
  readonly approvals: Read<readonly AgentdApproval[]>;
  /** The paired device may operate the environment, which Stop needs. */
  readonly canOperate: boolean;
}

export type EngineSectionId = "running" | "waiting" | "offered" | "done";

export interface EngineTaskItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly canStop: boolean;
}

export interface EngineSection {
  readonly id: EngineSectionId;
  readonly title: string;
  readonly tasks: readonly EngineTaskItem[];
}

export type EngineApprovals =
  | { readonly kind: "loading" }
  | {
      readonly kind: "list";
      readonly items: readonly { id: string; title: string; detail: string }[];
    }
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export type EngineScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "notSetUp"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly sections: readonly EngineSection[];
      readonly approvals: EngineApprovals;
      readonly approvalFooter: string;
    };

const SECTION_ORDER: readonly EngineSectionId[] = ["running", "waiting", "offered", "done"];

function isFinished(state: string): boolean {
  return state === "done" || state === "delivered" || state === "cancelled" || state === "declined";
}

// The same split as the desktop's Background tasks pane, for a list row alone.
function sectionOf(row: AgentdTaskRow, approvals: readonly AgentdApproval[]): EngineSectionId {
  if (isFinished(row.state)) return "done";
  if (row.runsOn !== "cloud") {
    const waits =
      row.a2aState === "auth-required" ||
      row.a2aState === "input-required" ||
      row.a2aState === "failed" ||
      row.workerState === "blocked" ||
      row.workerState === "suspect" ||
      row.workerState === "waiting_answer" ||
      row.workerState === "stopped" ||
      row.workerState === "gone" ||
      row.state === "held" ||
      row.state === "checkpoint" ||
      row.state === "blocked" ||
      approvals.some((approval) => approval.handoff === row.id);
    if (waits) return "waiting";
  }
  const queued =
    row.state === "offered" &&
    !row.workerRunning &&
    row.runsOn !== "cloud" &&
    !row.workerState &&
    (row.a2aState == null || row.a2aState === "submitted");
  return queued ? "offered" : "running";
}

function sectionTitle(id: EngineSectionId, resolve: MessageResolver): string {
  switch (id) {
    case "running":
      return resolve(msg("Running", { $context: "status of background work" }));
    case "waiting":
      return resolve(msg("Waiting on you"));
    case "offered":
      return resolve(msg("Offered", { $context: "background task not yet picked up" }));
    case "done":
      return resolve(msg("Done", { $context: "finished background work" }));
  }
}

function taskDetail(row: AgentdTaskRow): string {
  const parts = [row.project, row.workerName ?? row.workerTool].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : row.state;
}

export function deriveEngineScreen(
  input: EngineScreenInput,
  resolve: MessageResolver = m,
): EngineScreen {
  const { status, tasks, approvals, canOperate } = input;
  if (status === "loading") return { kind: "loading" };
  const notSetUp = {
    kind: "notSetUp",
    message: resolve(msg("Set up {product} on your computer", { product: "LibraOS Engine" })),
  } as const;
  if (status === "error") {
    return {
      kind: "unreachable",
      message: resolve(
        msg("Couldn't reach {product} on this computer.", {
          product: "LibraOS Engine",
        }),
      ),
    };
  }
  if ("_tag" in status) {
    if (status._tag === "AgentdNotFoundError" || status.notSetUp) return notSetUp;
    return { kind: "unreachable", message: status.message };
  }
  if (!status.setUp) return notSetUp;
  if (tasks === "loading") return { kind: "loading" };
  if (tasks === "error") {
    return {
      kind: "unreachable",
      message: resolve(msg("Couldn't read tasks from {product}.", { product: "LibraOS Engine" })),
    };
  }

  const pending = Array.isArray(approvals) ? approvals : [];
  const grouped = new Map<EngineSectionId, EngineTaskItem[]>();
  for (const row of tasks) {
    const section = sectionOf(row, pending);
    const items = grouped.get(section) ?? [];
    items.push({
      id: row.id,
      title: row.title,
      detail: taskDetail(row),
      // agentd stops only work this machine runs; finished work has nothing to stop.
      canStop: canOperate && section !== "done" && row.runsOn !== "cloud",
    });
    grouped.set(section, items);
  }
  const sections = SECTION_ORDER.flatMap((id) => {
    const items = grouped.get(id);
    return items ? [{ id, title: sectionTitle(id, resolve), tasks: items }] : [];
  });

  const titles = new Map(tasks.map((row) => [row.id, row.title]));
  const approvalView: EngineApprovals =
    approvals === "error"
      ? { kind: "error", message: resolve(msg("Couldn't read approvals")) }
      : approvals === "loading"
        ? { kind: "loading" }
        : approvals.length === 0
          ? { kind: "empty", message: resolve(msg("Nothing waits on you")) }
          : {
              kind: "list",
              items: approvals.map((approval) => ({
                id: approval.id,
                title: approval.text,
                detail:
                  (approval.handoff ? titles.get(approval.handoff) : undefined) ??
                  approval.project ??
                  approval.action ??
                  "",
              })),
            };

  return {
    kind: "ready",
    sections,
    approvals: approvalView,
    approvalFooter: resolve(msg("Answer on your computer")),
  };
}
