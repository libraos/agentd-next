import { AgentFeedbackKind, AgentFeedbackTrace } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

/** Turns the outline of a requested report covers at least. */
export const FEEDBACK_TRACE_TURNS = 5;

const reportFields = {
  kind: AgentFeedbackKind,
  subject: Schema.String.annotate({
    description: "LibraOS Next tool name, `lnext` command, or `general`.",
  }),
  expected: FeedbackText,
  actual: FeedbackText,
  workaround: FeedbackText.annotate({ description: "What you did instead, or empty." }),
  // Annotate before the default: an annotation after it never reaches the JSON schema.
  userRequested: Schema.Boolean.annotate({ description: "The user asked for this report." }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
};

export const FeedbackInput = Schema.Struct({
  ...reportFields,
  turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "How many recent turns, counting this one, the problem spans.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
});

export const FeedbackTrace = AgentFeedbackTrace;
export type FeedbackTrace = AgentFeedbackTrace;

const storedFields = {
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  source: Schema.Literals(["mcp", "cli"]),
  sent: Schema.Boolean,
};

export const FeedbackReport = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace),
});

/** What `feedback` answers: the report, with only the size of what its trace attached. */
export const FeedbackSubmitResult = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace.mapFields(Struct.omit(["entries"]))),
});

export const FEEDBACK_AWAITING_APPROVAL_NOTE =
  "The user sees this report in a card and chooses there whether to send it and whether to include the conversation. Nothing is sent until they do, and you will not learn their choice. Do not wait for it or send it another way. Call again only if the user asks to change it; that shows a new card.";

/** What `feedback` answers for a requested report: shown to the user, not yet sent. */
export const FeedbackAwaitingApproval = Schema.Struct({
  status: Schema.Literal("awaiting_approval"),
  note: Schema.String,
});
export type FeedbackAwaitingApproval = typeof FeedbackAwaitingApproval.Type;

export const FEEDBACK_OFF_MESSAGE =
  "Agent feedback is off. Turn it on in LibraOS Next under Settings > Labs, then try again.";

export class FeedbackOffError extends Schema.TaggedError<FeedbackOffError>()(
  "FeedbackOffError",
  {},
) {
  override get message() {
    return FEEDBACK_OFF_MESSAGE;
  }
}

export type FeedbackSource = "mcp" | "cli";

// Requested reports count when their card is shown, unprompted ones when stored.
export const MAX_REPORTS_PER_TURN = 3;
// Reports from no turn, such as `t3 feedback`, have no turn to count in.
export const MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR = 10;

export class FeedbackLimitError extends Schema.TaggedError<FeedbackLimitError>()(
  "FeedbackLimitError",
  { scope: Schema.Literals(["turn", "hour", "cards"]) },
) {
  override get message() {
    switch (this.scope) {
      case "turn":
        return `This turn already sent ${MAX_REPORTS_PER_TURN} agent feedback reports; nothing was sent.`;
      case "cards":
        return `This turn already showed the user ${MAX_REPORTS_PER_TURN} agent feedback reports to approve; nothing was shown.`;
      case "hour":
        return `This machine already sent ${MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR} agent feedback reports outside a turn in the last hour; nothing was sent.`;
    }
  }
}

export class FeedbackNotRequestedError extends Schema.TaggedError<FeedbackNotRequestedError>()(
  "FeedbackNotRequestedError",
  { source: Schema.Literals(["mcp", "cli"]) },
) {
  override get message() {
    return this.source === "cli"
      ? "Agent feedback is set to When I ask: ask your agent in a thread to send it, so you can approve what is sent."
      : "Agent feedback is set to When I ask: send a report only when the user asks for one.";
  }
}

export class FeedbackStorageError extends Schema.TaggedError<FeedbackStorageError>()(
  "FeedbackStorageError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not save agent feedback.";
  }
}

/** The MCP client label `t3 feedback` signs in with, so its reports count as `cli`. */
export const FEEDBACK_CLI_CLIENT_LABEL = "t3 feedback cli";

/** Listed `lnext` command paths a report may name. A CLI test keeps this in step with binCli. */
export const CLI_COMMAND_SUBJECTS: ReadonlyArray<string> = [
  "lnext",
  "lnext help",
  "lnext serve",
  "lnext app",
  "lnext pair",
  "lnext auth",
  "lnext auth connect-device",
  "lnext auth connect-device approve",
  "lnext auth connect-device list",
  "lnext auth connect-device revoke",
  "lnext auth pairing",
  "lnext auth pairing create",
  "lnext auth pairing list",
  "lnext auth pairing revoke",
  "lnext auth session",
  "lnext auth session issue",
  "lnext auth session list",
  "lnext auth session revoke",
  "lnext environment",
  "lnext environment link",
  "lnext environment list",
  "lnext environment unlink",
  "lnext browser",
  "lnext browser setup",
  "lnext project",
  "lnext project add",
  "lnext project remove",
  "lnext project rename",
  "lnext thread",
  "lnext thread list",
  "lnext thread start",
  "lnext thread send",
  "lnext thread show",
  "lnext feedback",
  "lnext feedback list",
  "lnext workflow",
  "lnext workflow start",
  "lnext workflow list",
  "lnext workflow show",
  "lnext workflow resume",
  "lnext workflow cancel",
  "lnext workflow signal",
  "lnext workflow withdraw",
  "lnext workflow questions",
  "lnext workflow hooks",
  "lnext workflow store",
  "lnext workflow store list",
  "lnext workflow store set",
  "lnext workflow store delete",
  "lnext up",
  "lnext status",
  "lnext service",
  "lnext service install",
  "lnext service restart",
  "lnext service uninstall",
  "lnext service status",
  "lnext service protect",
  "lnext update",
  "lnext install",
  "lnext uninstall",
  "lnext theme",
  "lnext theme set",
  "lnext theme clear",
  "lnext theme show",
  "lnext trace",
  "lnext trace summary",
  "lnext doctor",
  "lnext policy",
  "lnext policy show",
  "lnext policy check",
  "lnext policy templates",
  "lnext policy settings",
  "lnext triage",
  "lnext connect",
  "lnext connect link",
  "lnext connect login",
  "lnext connect logout",
  "lnext connect publish",
  "lnext connect status",
  "lnext connect unlink",
];

export type FeedbackInput = typeof FeedbackInput.Type;
export type FeedbackReport = typeof FeedbackReport.Type;

export const FEEDBACK_SUBJECT_MESSAGE =
  "Set subject to the exact LibraOS Next tool name, the `lnext` command, or `general`.";

// The shared resolver knows the presented tools; the prefix covers the rest, such as these.
// Codex also registers `agentd-next-direct` for AgentD tools it keeps out of Code Mode.
const T3_PREFIX =
  /^(?:mcp__(?:agentd[-_]?next|t3[-_]?code)(?:[-_]direct)?__|(?:agentd[-_]?next|t3[-_]?code)(?:[-_]direct)?[.:/])/iu;

/** The bare name of a registered AgentD tool however a provider prefixed it, else undefined. */
export const resolveT3ToolName = (name: string, toolNames: ReadonlyArray<string>) => {
  const tool = resolveT3McpToolId(name) ?? name.replace(T3_PREFIX, "");
  if (toolNames.includes(tool)) return tool;
  // OpenCode 2 prefixes tools with `agentd-next-<thread>_`, underscores and all: the longest name wins.
  if (!/^(?:agentd-next|t3-code)-/iu.test(name)) return undefined;
  return toolNames
    .filter((candidate) => name.endsWith(`_${candidate}`))
    .toSorted((a, b) => b.length - a.length)[0];
};

// The command's earlier names; a subject naming one is stored under `lnext`.
const EARLIER_COMMAND_NAME = /^(?:t3|agentd-next|libraos-next)(?= |$)/u;

/** The stored subject, or undefined when the value names no LibraOS Next tool, `lnext` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general") return subject;
  const command = subject.replace(EARLIER_COMMAND_NAME, "lnext");
  if (CLI_COMMAND_SUBJECTS.includes(command)) return command;
  return resolveT3ToolName(subject, toolNames);
};
