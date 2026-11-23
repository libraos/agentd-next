import {
  AgentdStartTaskInput,
  AgentdTaskSize,
  AgentdWorkerTool,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudModelAccess,
  type AgentdCloudPlan,
  type AgentdCloudSubscription,
  type AgentdTaskEstimate,
  type ClientSettings,
  type MessageId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const TASK_TEXT_LIMIT = 4000;
export const TASK_ACCEPT_LIMIT = 20;
export const TASK_BUDGET_LIMIT = 14;
export const TASK_ISSUE_LIMIT = 212;
export const TASK_WORKERS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
} satisfies Record<AgentdWorkerTool, string>;

export interface TaskFields {
  readonly goal: string;
  readonly accept: string;
  readonly check: string;
  readonly worker: AgentdWorkerTool | null;
  readonly budget: string;
  readonly issue: string;
  /** The chat draft's size; it only chooses which agentd estimate fills the budget. */
  readonly size: AgentdTaskSize;
}

export const EMPTY_TASK_FIELDS: TaskFields = {
  goal: "",
  accept: "",
  check: "",
  worker: null,
  budget: "",
  issue: "",
  size: "",
};

const isBudget = Schema.is(AgentdStartTaskInput.fields.budget);
const isIssue = Schema.is(AgentdStartTaskInput.fields.issue);
const isTaskText = (text: string) =>
  text.length <= TASK_TEXT_LIMIT && !text.startsWith("-") && !text.includes("\0");

/** The dollars of an agentd budget such as `30m,$5`; null when it names none. */
export function budgetDollarCap(budget: string): number | null {
  const match = /\$(\d+(?:\.\d+)?)/.exec(budget);
  return match ? Number(match[1]) : null;
}

/**
 * `dollarBudgets` is agentd's answer to whether a local worker can take a dollar budget; with
 * `false` a budget naming dollars is refused here, before agentd refuses it after Start.
 */
export function prepareTaskFields(
  fields: TaskFields,
  { dollarBudgets = null }: { readonly dollarBudgets?: boolean | null } = {},
) {
  const accept = fields.accept
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const input = {
    goal: fields.goal.trim(),
    accept,
    check: fields.check.trim(),
    budget: fields.budget.trim(),
    issue: fields.issue.trim() || null,
  };

  return {
    input,
    goal: input.goal === "" ? "required" : !isTaskText(input.goal) ? "invalid" : null,
    check: input.check === "" ? "required" : !isTaskText(input.check) ? "invalid" : null,
    budget:
      input.budget === ""
        ? "required"
        : !isBudget(input.budget) ||
            input.budget.split(",").some((limit) => parseFloat(limit.replace("$", "")) <= 0)
          ? "invalid"
          : dollarBudgets === false && budgetDollarCap(input.budget) !== null
            ? "no-prices"
            : null,
    accept:
      fields.accept.length > TASK_TEXT_LIMIT ||
      accept.length > TASK_ACCEPT_LIMIT ||
      !accept.every(isTaskText),
    issue: !isIssue(input.issue),
  } as const;
}

export function taskBranchProblem(status: {
  readonly isRepo: boolean;
  readonly refName: string | null;
}) {
  if (!status.isRepo) return "not-repo";
  if (status.refName === null) return "detached";
  if (status.refName === "main" || status.refName === "master") return "protected";
  return null;
}

export const TASK_DRAFT_PROMPT = `Draft an AgentD worker task from this conversation. Draft only: do not call tools, run commands, change files, create or dispatch a task, or request approval. I will review the fields myself.
Respond with only a JSON object in this exact shape:
{"goal":"","accept":[],"check":"","worker":null,"budget":"","issue":"","size":""}
Write up to ${TASK_ACCEPT_LIMIT} acceptance criteria as an array of single-line strings. Suggest a check command but do not run it. Leave the budget and issue empty unless we discussed them. A budget uses minutes (30m), dollars ($2), or both (30m,$2); an issue uses OWNER/REPO#123. Leave worker null unless I asked for claude, codex, or opencode. Set size to "small" for a small fix or test, "feature" for a feature or integration, "complex" for a larger change, or "" if unsure. Use empty strings for unknown fields.`;

const draftSchema = Schema.Struct({
  goal: Schema.String.check(Schema.isMaxLength(TASK_TEXT_LIMIT)),
  accept: Schema.Array(Schema.String.check(Schema.isMaxLength(TASK_TEXT_LIMIT))).check(
    Schema.isMaxLength(TASK_ACCEPT_LIMIT),
  ),
  check: Schema.String.check(Schema.isMaxLength(TASK_TEXT_LIMIT)),
  worker: Schema.NullOr(AgentdWorkerTool),
  budget: Schema.String.check(Schema.isMaxLength(TASK_BUDGET_LIMIT)),
  issue: Schema.String.check(Schema.isMaxLength(TASK_ISSUE_LIMIT)),
  size: Schema.optionalKey(AgentdTaskSize),
});
const decodeDraft = Schema.decodeUnknownOption(Schema.fromJsonString(draftSchema));

function parseTaskDraft(reply: string): TaskFields | null {
  const text = reply.trim();
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)?.[1];
  const decoded = decodeDraft(fenced ?? text);
  if (decoded._tag === "None") return null;
  const { accept, worker, size = "", ...fields } = decoded.value;
  const acceptanceText = accept.join("\n");
  if (acceptanceText.length > TASK_TEXT_LIMIT || accept.some((line) => /[\r\n]/.test(line)))
    return null;
  return { ...fields, accept: acceptanceText, worker, size };
}

export function conversationTaskDraft(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems"> | undefined,
  messageId: MessageId,
):
  | { readonly kind: "waiting" | "failed" }
  | { readonly kind: "ready"; readonly fields: TaskFields } {
  const run = projection?.runs.find((candidate) => candidate.userMessageId === messageId);
  if (run === undefined || run.completedAt === null) return { kind: "waiting" };
  if (run.status !== "completed") return { kind: "failed" };
  const reply = projection?.turnItems.findLast(
    (item) =>
      item.runId === run.id &&
      item.type === "assistant_message" &&
      item.phase !== "commentary" &&
      !item.streaming,
  );
  const fields = reply?.type === "assistant_message" ? parseTaskDraft(reply.text) : null;
  return fields === null ? { kind: "failed" } : { kind: "ready", fields };
}

/** The prompt's opening, which marks a user message as a request for a task draft. */
const DRAFT_PROMPT_OPENING = TASK_DRAFT_PROMPT.slice(0, TASK_DRAFT_PROMPT.indexOf("."));

/** A finished assistant reply to the task draft prompt, as task fields; null for any other reply. */
export function taskDraftReply(
  items: ReadonlyArray<{ readonly type: string; readonly runId?: unknown }>,
  reply: {
    readonly type: string;
    readonly runId?: unknown;
    readonly phase?: unknown;
    readonly text: string;
  },
): TaskFields | null {
  if (reply.type !== "assistant_message" || reply.phase === "commentary") return null;
  if (reply.runId === undefined || !/^\s*[{`]/.test(reply.text)) return null;
  const asked = items.some(
    (item) =>
      item.type === "user_message" &&
      item.runId === reply.runId &&
      "text" in item &&
      typeof item.text === "string" &&
      item.text.startsWith(DRAFT_PROMPT_OPENING),
  );
  return asked ? parseTaskDraft(reply.text) : null;
}

const FALLBACK = { minutes: 60, dollars: 5 } as const;

/** Whole dollars, or cents when the amount has them. */
export function budgetDollars(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/**
 * The budget a Start fills in: agentd's high estimate rounded up to a whole dollar (capped by the
 * balance for Cloud Workers), agentd's default minutes or the fallback's; the fallback (Settings →
 * Workers, else `60m,$5`) when there is no estimate.
 */
export function autoBudget({
  estimate,
  defaultMinutes,
  balanceUsd,
  fallback = FALLBACK,
}: {
  readonly estimate: Pick<AgentdTaskEstimate, "high"> | null;
  readonly defaultMinutes: number | null;
  /** Cloud Workers only: the available credit. */
  readonly balanceUsd: number | null;
  readonly fallback?: { readonly minutes: number; readonly dollars: number } | null;
}): { readonly minutes: number; readonly dollars: number } {
  const usual = fallback ?? FALLBACK;
  const minutes = defaultMinutes ?? usual.minutes;
  const wanted = estimate === null ? usual.dollars : Math.ceil(estimate.high);
  const dollars =
    balanceUsd === null
      ? wanted
      : Math.min(wanted, Math.floor(Math.max(balanceUsd, 0) * 100) / 100);
  return { minutes, dollars };
}

/**
 * The budget a local Start fills in: minutes and dollars, or minutes only while agentd has no model
 * prices to hold a dollar limit with.
 */
export function localBudget(
  budget: { readonly minutes: number; readonly dollars: number },
  dollarBudgets: boolean | null,
): string {
  return dollarBudgets === false
    ? `${budget.minutes}m`
    : `${budget.minutes}m,$${budgetDollars(budget.dollars)}`;
}

/** The minutes of an agentd budget such as `30m,$5`; null when it names none. */
export function budgetMinutes(budget: string | null | undefined): number | null {
  const match = /^(\d{1,4})m(?:,|$)/.exec(budget ?? "");
  return match ? Number(match[1]) : null;
}

/** The dollars of an agentd budget such as `30m,$5`; null when it names none. */
export function budgetDollarLimit(budget: string | null | undefined): number | null {
  const match = /(?:^|,)\$(\d+(?:\.\d+)?)$/.exec(budget ?? "");
  return match ? Number(match[1]) : null;
}

/** LibraOS when the person is signed in to it or the Gateway is connected; else their own key. */
export function defaultModelAccess(signedIn: boolean, gatewayConnected: boolean) {
  return signedIn || gatewayConnected ? ("libraos" as const) : ("byok" as const);
}

/**
 * Why a plan cannot run this task: agentd too old for it, setup not offered on this host (Windows),
 * no credential configured, or one agentd cannot use. Null when it can; a chosen file always can.
 */
export type CloudPlanProblem = "agentd" | "windows" | "not-set-up" | "invalid";

export function cloudPlanProblem(
  subscription: AgentdCloudSubscription | null | undefined,
  plan: AgentdCloudPlan,
  fileChosen: boolean,
): CloudPlanProblem | null {
  const state = subscription?.[plan];
  if (!state?.supported) return "agentd";
  if (fileChosen || (state.configured && state.valid !== false)) return null;
  if (subscription?.setupUnavailable) return "windows";
  return state.configured ? "invalid" : "not-set-up";
}

/** The plan a subscription starts on: Claude unless only the ChatGPT plan is ready. */
export function defaultCloudPlan(
  subscription: AgentdCloudSubscription | null | undefined,
): AgentdCloudPlan {
  return cloudPlanProblem(subscription, "claude", false) !== null &&
    cloudPlanProblem(subscription, "codex", false) === null
    ? "codex"
    : "claude";
}

/** The Model access menu: subscription is listed, and disabled while agentd can't run it. */
export function modelAccessChoices(subscription: AgentdCloudSubscription | null | undefined) {
  return [
    { value: "libraos", disabled: false },
    { value: "byok", disabled: false },
    { value: "subscription", disabled: !subscription?.claude.supported },
  ] as const satisfies ReadonlyArray<{ value: AgentdCloudModelAccess; disabled: boolean }>;
}

/** A key typed or pasted where its file's path belongs. */
const GITHUB_THING = String.raw`(?:issues?|pull requests?|prs?|reviews?|review comments?|discussions?)`;
const GITHUB_ASK = new RegExp(
  [
    String.raw`\b(?:open|create|file|raise|submit|comment on|reply to|respond to|answer|close|label|merge|approve)\b[^.\n]{0,60}\b${GITHUB_THING}\b`,
    String.raw`\b(?:push|publish|commit)\b[^.\n]{0,40}\b(?:another|a different|other) repo`,
    "(?:开|提|创建|新建|回复|评论|关闭|合并)[^。\\n]{0,20}(?:issue|pr|pull request|议题|评审)",
  ].join("|"),
  "i",
);

/**
 * Whether a goal asks for something a cloud task cannot deliver: its token only pushes a branch
 * to the task's repository, so issues, pull requests, comments and other repositories are out.
 */
export function goalAsksBeyondCloudReach(goal: string): boolean {
  return GITHUB_ASK.test(goal);
}

export function looksLikeKey(value: string): boolean {
  const text = value.trim();
  return text.startsWith("sk-") || (text.length > 30 && !/[/\\]/.test(text));
}

export type KeyFileProblem =
  | "anthropic-key"
  | "openai-key"
  | "open-to-others"
  | "unreadable"
  | "checking"
  | "check-failed"
  | "unchecked";

/**
 * Why a BYOK key file under `field` can't be submitted yet, from the host's check of it: null
 * while the check is still running, "failed" when the host couldn't answer.
 */
export function keyFileProblem(
  field: "anthropic" | "openai",
  check: AgentdCloudKeyFileCheck | null | "failed" | "not-permitted",
): KeyFileProblem | null {
  if (check === null) return "checking";
  if (check === "failed") return "check-failed";
  // This connection may not read host files: agentd checks the file on Start instead.
  if (check === "not-permitted") return "unchecked";
  if (!check.readable) return "unreadable";
  if (check.provider !== null && check.provider !== field) return `${check.provider}-key`;
  return check.openToOthers ? "open-to-others" : null;
}

type RememberedKeyFiles = ClientSettings["agentdCloudKeyFiles"];

/** The BYOK paths agentd accepted at `now`, merged into the latest per-environment record. */
export function rememberKeyFiles(
  latest: RememberedKeyFiles,
  environmentId: string,
  submitted: { readonly anthropicKeyFile?: string; readonly openaiKeyFile?: string },
  now: number,
): RememberedKeyFiles {
  return {
    ...latest,
    [environmentId]: {
      ...latest[environmentId],
      ...(submitted.anthropicKeyFile
        ? { anthropic: submitted.anthropicKeyFile, anthropicSavedAt: now }
        : {}),
      ...(submitted.openaiKeyFile ? { openai: submitted.openaiKeyFile, openaiSavedAt: now } : {}),
    },
  };
}

export type TaskStartProblem =
  | "balance"
  | "sign-in"
  | "subscription"
  | "worker"
  | "no-directory"
  | "not-repo"
  | "detached";

/** The first thing that stops a Start, for one line beside a disabled Start; null when none. */
export function taskStartProblem(input: {
  readonly cloud: boolean;
  readonly balanceUsd: number | null;
  readonly creditProblem: boolean;
  readonly modelAccess: AgentdCloudModelAccess;
  /** With subscription: why the chosen plan can't run it. */
  readonly planProblem: CloudPlanProblem | null;
  readonly signedIn: boolean;
  readonly gatewayConnected: boolean;
  readonly worker: AgentdWorkerTool | null;
  readonly hasDirectory: boolean;
  readonly branch: ReturnType<typeof taskBranchProblem> | null;
}): TaskStartProblem | null {
  if (!input.hasDirectory) return "no-directory";
  if (input.cloud) {
    if (input.creditProblem || (input.balanceUsd !== null && input.balanceUsd < 0.01))
      return "balance";
    if (input.modelAccess === "libraos" && !input.signedIn && !input.gatewayConnected)
      return "sign-in";
    if (input.modelAccess === "subscription" && input.planProblem !== null) return "subscription";
    return null;
  }
  // agentd gives a worker on the default branch its own worktree and branch, so that is no problem.
  if (input.branch === "not-repo" || input.branch === "detached") return input.branch;
  if (input.worker === null) return "worker";
  return null;
}

/** Job states of a cloud task that is under way or done; a failed or stopped one never started well. */
const CLOUD_STARTED = new Set(["queued", "running", "settling", "completed"]);

/**
 * The cloud job of a task agentd saved without confirming it is under way, by the synced list. A
 * job that failed or stopped isn't: the dialog keeps the reason agentd gave.
 */
export function cloudOfferStarted(
  rows: ReadonlyArray<{ readonly id: string; readonly cloudState?: string | null }> | null,
  id: string,
): boolean {
  const state = rows?.find((row) => row.id === id)?.cloudState;
  return state !== null && state !== undefined && CLOUD_STARTED.has(state);
}

const CLOUD_ENDED = new Set(["failed", "failed_verification", "cancelled", "budget_exceeded"]);

/** The cloud job of a saved offer failed or stopped before it started well. */
export function cloudOfferEnded(
  rows: ReadonlyArray<{ readonly id: string; readonly cloudState?: string | null }> | null,
  id: string,
): boolean {
  const state = rows?.find((row) => row.id === id)?.cloudState;
  return state !== null && state !== undefined && CLOUD_ENDED.has(state);
}
