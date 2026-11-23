/**
 * Automatic continuation of a thread whose agent ended its turn saying work remains.
 *
 * "Work remains" is decided only by a fixed status line the agent is asked to end its final
 * message with (see AUTO_CONTINUATION_STATUS_INSTRUCTIONS). Prose is never interpreted, and no
 * marker means no automatic continuation.
 */

export type CompletionStatus =
  | { readonly type: "done" }
  | { readonly type: "remaining"; readonly detail: string }
  | { readonly type: "blocked"; readonly detail: string };

export const AUTO_CONTINUATION_STATUS_INSTRUCTIONS = `<completion_status>
End your final message of a turn with one line that says where the user's request stands: "Status: done" when it is complete; "Status: remaining: <what is left>" when work you could do yourself is left; "Status: blocked: <reason>" when only the user or something outside your control can unblock it, including when you ask the user a question. Write it only as the last line of your own message, never inside quoted text, files or tool input. Delegated children skip this line.
</completion_status>`;

const STATUS_LINE = /^\**status:\**\s*(done|remaining|blocked)\b\s*(?:[:—–-]\s*(.*?))?\s*\**$/i;

/** Reads the status line; only the last non-empty line of the agent's own final message counts. */
export function parseCompletionStatus(finalMessage: string): CompletionStatus | undefined {
  const lines = finalMessage.split(/\r?\n/);
  let last: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length > 0) {
      last = line;
      break;
    }
  }
  if (last === undefined) return undefined;
  const match = STATUS_LINE.exec(last);
  if (match === null) return undefined;
  const kind = match[1]!.toLowerCase();
  const detail = (match[2] ?? "").trim();
  if (kind === "done") return { type: "done" };
  return { type: kind === "remaining" ? "remaining" : "blocked", detail };
}

const STATUS_KINDS = ["done", "remaining", "blocked"] as const;

/**
 * The message as people read it: the agent's trailing status line is for AgentD, so it is left
 * out, and so is a line that is still streaming toward one.
 */
export function withoutCompletionStatus(text: string, streaming = false): string {
  const end = text.trimEnd();
  const start = end.lastIndexOf("\n") + 1;
  const last = end.slice(start).trim();
  const partial = last.replace(/\*/g, "").toLowerCase();
  const hide =
    STATUS_LINE.test(last) ||
    (streaming &&
      partial.length > 0 &&
      STATUS_KINDS.some((kind) => `status: ${kind}`.startsWith(partial)));
  return hide ? end.slice(0, start).trimEnd() : text;
}

/** Only these get a notice; a stop, error, limit, question or blocker already shows in the thread. */
export type AutoContinuationStopReason = "limit_reached" | "no_progress";

export type AutoContinuationDecision =
  | { readonly type: "none" }
  | { readonly type: "continue"; readonly remaining: string; readonly continuation: number }
  | {
      readonly type: "stop";
      readonly reason: AutoContinuationStopReason;
      readonly remaining: string;
    };

export interface AutoContinuationInput {
  readonly enabled: boolean;
  readonly maxContinuations: number;
  /** How the run ended; only a normally completed turn may continue. */
  readonly runStatus: "completed" | "interrupted" | "failed" | "cancelled" | "waiting";
  /** The text of the run's last root assistant message; tool output and subagent text never count. */
  readonly finalMessage: string | undefined;
  readonly userStopped: boolean;
  /** An approval, question or other input the turn is waiting on. */
  readonly awaitingUser: boolean;
  readonly usageLimited: boolean;
  /** Automatic continuations already made since the user's last message. */
  readonly continuationsSoFar: number;
  /** For a run that is itself an automatic continuation: whether it called a tool or changed a file. */
  readonly madeProgress: boolean;
}

export function decideAutoContinuation(input: AutoContinuationInput): AutoContinuationDecision {
  const status =
    input.finalMessage === undefined ? undefined : parseCompletionStatus(input.finalMessage);
  if (
    !input.enabled ||
    status === undefined ||
    status.type !== "remaining" ||
    input.userStopped ||
    input.runStatus !== "completed" ||
    input.usageLimited ||
    input.awaitingUser
  )
    return { type: "none" };
  const remaining = status.detail;
  const stop = (reason: AutoContinuationStopReason) =>
    ({ type: "stop", reason, remaining }) as const;
  if (input.continuationsSoFar > 0 && !input.madeProgress) return stop("no_progress");
  if (input.continuationsSoFar >= input.maxContinuations) return stop("limit_reached");
  return { type: "continue", remaining, continuation: input.continuationsSoFar + 1 };
}

/**
 * The continuation's message is fixed text: the agent's own "remaining" words are already in its
 * context, and quoting them would send model output (which can carry names from files the agent
 * read) through the before-send hooks, where a redaction rewrite cannot be reviewed and stops the
 * chain. Fixed text carries nothing to redact.
 */
export const AUTO_CONTINUATION_PROMPT =
  "Continue toward the user's original request without waiting for them. Do the remaining work your last message named that you can do yourself, within the permissions you already have.";

const STOP_EXPLANATIONS: Record<AutoContinuationStopReason, string> = {
  limit_reached: "The limit of automatic continuations for your last message was reached.",
  no_progress: "The last automatic continuation made no progress (no tool call or file change).",
};

export function autoContinuationStopMessage(
  reason: AutoContinuationStopReason,
  remaining: string,
): string {
  const left = remaining.length === 0 ? "" : ` What remains: ${remaining}`;
  return `Not continued automatically. ${STOP_EXPLANATIONS[reason]}${left} Send a message to continue.`;
}
