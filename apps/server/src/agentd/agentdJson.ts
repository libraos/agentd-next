import type {
  AgentdApproval,
  AgentdApprovalListJson,
  AgentdDoctorJson,
  AgentdHandoffListJsonRow,
  AgentdHandoffShowJson,
  AgentdHolder,
  AgentdInboxItem,
  AgentdInboxListJson,
  AgentdPerson,
  AgentdRunsOn,
  AgentdStatus,
  AgentdTask,
  AgentdTaskRow,
  AgentdUserListJson,
  AgentdWhoJson,
  AgentdWorkerTool,
} from "@t3tools/contracts";

import { cloudJobNote } from "./agentdCloud.ts";
import { cloudPullRequest } from "./agentdCloudReview.ts";

const AGENT_TOOLS: ReadonlyArray<AgentdWorkerTool> = ["claude", "codex", "opencode"];
const WORKER_TOOLS = new Set<string>(AGENT_TOOLS);

// agentd names a session after its tool: "codex-615065aa16".
function toolOfSession(session: string | null | undefined): string | null {
  const tool = session?.match(/^([a-z]+)-[0-9a-f]+$/)?.[1];
  return tool !== undefined && WORKER_TOOLS.has(tool) ? tool : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

// doctor's `${tool}-mcp` check fails alike for "never registered" and for this; only the detail
// tells them apart. The command is Go-quoted, so a Windows path carries escaped backslashes.
const STALE_COMMAND = /^server \S+ runs "(?:[^"\\]|\\.)*", which is not there$/;

function isStaleCommandDetail(detail: string | undefined): boolean {
  return detail !== undefined && STALE_COMMAND.test(detail.trim());
}

/** The agents whose agentd MCP registration runs a command that is no longer there. */
export function staleRegistrations(doctor: AgentdDoctorJson): AgentdWorkerTool[] {
  return AGENT_TOOLS.filter((tool) =>
    doctor.checks.some(
      (check) =>
        check.id === `${tool}-mcp` && check.status === "fail" && isStaleCommandDetail(check.detail),
    ),
  );
}

/** The EULA version doctor's activation check says is accepted; false: none is; null: it does not say. */
export function acceptedEula(doctor: AgentdDoctorJson): string | false | null {
  const detail = doctor.checks.find((check) => check.id === "activation")?.detail ?? "";
  if (/\bEULA is not accepted\b/.test(detail)) return false;
  return /\bEULA (\S+) accepted\b/.exec(detail)?.[1] ?? null;
}

/** The version `agentd eula` names in its text ("Version 3.5 of November 13, 2026."). */
export function eulaVersion(text: string): string | null {
  return /^Version (\S+) of\b/m.exec(text)?.[1] ?? null;
}

// agentd saves "eula-draft-3.5" for the agreement whose text says "Version 3.5"; compare the numbers.
function sameEula(saved: string, carried: string | null): boolean {
  const number = (value: string) => /(\d+(?:\.\d+)*)$/.exec(value)?.[1] ?? null;
  const a = number(saved);
  const b = carried === null ? null : number(carried);
  return a === null || b === null || a === b;
}

/** Set up for the app: agentd's own answer, and the EULA this agentd carries accepted. */
export function agentdStatus(
  version: string,
  doctor: AgentdDoctorJson,
  carriedEula: string | null = null,
): AgentdStatus {
  const accepted = acceptedEula(doctor);
  const serverDetail = doctor.checks.find((check) => check.id === "server")?.detail;
  const teamServer = serverDetail?.startsWith("not joined to an agentd server:")
    ? null
    : serverDetail?.match(/^(https?:\/\/\S+): device /)?.[1];
  return {
    version: version.trim(),
    ok: doctor.ok ?? doctor.checks.every((check) => check.status !== "fail"),
    setUp:
      (doctor.set_up ?? true) &&
      accepted !== false &&
      (accepted === null || sameEula(accepted, carriedEula)),
    ...(teamServer === undefined ? {} : { teamServer }),
    checks: doctor.checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.detail ?? null,
      fix: check.fix ?? null,
    })),
  };
}

export function agentdTaskRow(row: AgentdHandoffListJsonRow): AgentdTaskRow {
  const cloudState = nonEmpty(row.cloud_state);
  const node = row.claimer?.match(/^wrk-(.+)$/)?.[1];
  const runsOn = cloudState !== null ? "cloud" : node === undefined ? "local" : "team";
  const workerName = node ?? nonEmpty(row.claimer_user) ?? nonEmpty(row.claimer);
  return {
    id: row.id,
    title: nonEmpty(row.title) ?? row.goal ?? "",
    state: row.state,
    workerState: nonEmpty(row.worker_state) ?? cloudState,
    workerRunning: row.worker_running === true,
    workerTool: toolOfSession(row.claimer),
    ...(workerName === null || runsOn === "cloud" ? {} : { workerName }),
    ...(nonEmpty(row.worker_cwd) === null ? {} : { workerCwd: nonEmpty(row.worker_cwd) }),
    runsOn,
    project: nonEmpty(row.project),
    issue: nonEmpty(row.issue),
    started: null,
    branch: null,
    updated: nonEmpty(row.updated),
    ...(cloudState === null ? {} : { cloudState, cloudUsd: row.cloud_usd ?? null }),
  };
}

function optionalReport(note: string | null | undefined): { report?: string } {
  const report = nonEmpty(note);
  return report === null ? {} : { report };
}

function runsOn(show: AgentdHandoffShowJson): AgentdRunsOn {
  if (nonEmpty(show.cloud_state) !== null) return "cloud";
  return nonEmpty(show.lease_device) === null ? "local" : "team";
}

export function agentdTask(show: AgentdHandoffShowJson): AgentdTask {
  const goal = show.body?.goal ?? "";
  const verdict = show.verdict ?? null;
  const total = show.cost?.total ?? null;
  const cloudState = nonEmpty(show.cloud?.state) ?? nonEmpty(show.cloud_state);
  const modelAccess = nonEmpty(show.body?.model_access);
  return {
    id: show.id,
    title: nonEmpty(show.title) ?? goal,
    goal,
    state: show.state,
    workerState: nonEmpty(show.worker_state),
    workerTool: nonEmpty(show.worker_tool) ?? nonEmpty(show.start_tool),
    runsOn: runsOn(show),
    accept: show.accept ?? [],
    check: nonEmpty(show.check_cmd),
    verdict:
      verdict === null
        ? null
        : {
            verdict: verdict.verdict,
            check: verdict.check ?? null,
            delivery: verdict.delivery ?? null,
            next: verdict.next ?? null,
          },
    costUsd: total?.usd ?? null,
    costEstimate: total?.estimate === true,
    budget: nonEmpty(show.budget),
    budgetState: nonEmpty(show.budget_state),
    branch: nonEmpty(show.worker_branch) ?? nonEmpty(show.lease_branch),
    note:
      cloudJobNote(cloudState, [show.cloud?.result, show.cloud?.note]) ??
      nonEmpty(show.worker_note) ??
      nonEmpty(show.close_reason),
    ...optionalReport(show.report_note),
    project: nonEmpty(show.project),
    hasLog: nonEmpty(show.worker_log) !== null,
    started: nonEmpty(show.created),
    updated: nonEmpty(show.updated),
    ...(cloudState === null
      ? {}
      : {
          cloud: {
            state: cloudState,
            modelAccess:
              modelAccess === "byok" || modelAccess === "subscription"
                ? modelAccess
                : modelAccess === null || modelAccess === "libraos"
                  ? "libraos"
                  : null,
            plan:
              modelAccess !== "subscription"
                ? null
                : nonEmpty(show.body?.codex_auth_file) !== null
                  ? "codex"
                  : "claude",
            workerUsd: show.cloud?.worker_usd ?? null,
            inferenceUsd: show.cloud?.inference_usd ?? null,
            totalUsd: show.cloud?.total_usd ?? null,
            pullRequest: cloudPullRequest(show),
          },
        }),
  };
}

export function agentdApprovals(list: typeof AgentdApprovalListJson.Type): AgentdApproval[] {
  return list.map((approval) => ({
    id: approval.id,
    text: approval.text,
    requester: nonEmpty(approval.session),
    action: approval.action ?? null,
    handoff: nonEmpty(approval.handoff),
    project: nonEmpty(approval.project),
    ref: nonEmpty(approval.ref),
    requiredRole: nonEmpty(approval.required_role),
    created: nonEmpty(approval.created),
  }));
}

export function agentdInbox(list: typeof AgentdInboxListJson.Type): AgentdInboxItem[] {
  return list.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: nonEmpty(item.title) ?? item.goal ?? "",
    requester: nonEmpty(item.claimer) ?? nonEmpty(item.from),
    handoff: nonEmpty(item.handoff),
    at: nonEmpty(item.at),
    read: item.read === true,
    resolved: item.resolved === true,
  }));
}

export function agentdPeople(list: typeof AgentdUserListJson.Type): AgentdPerson[] {
  return list.map((user) => ({ name: user.name, role: user.role, created: user.created ?? null }));
}

export function agentdHolders(who: typeof AgentdWhoJson.Type): AgentdHolder[] {
  return (who.holders ?? []).map((holder) => ({
    user: nonEmpty(holder.user),
    tool: nonEmpty(holder.tool),
    node: nonEmpty(holder.node),
    path: nonEmpty(holder.path),
    since: nonEmpty(holder.since),
  }));
}
