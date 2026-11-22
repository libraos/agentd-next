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

export type AutoContinuationStopReason =
  | "blocked"
  | "awaiting_user"
  | "stopped"
  | "failed"
  | "usage_limit"
  | "limit_reached"
  | "no_progress";

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
  if (!input.enabled || status === undefined || status.type === "done") return { type: "none" };
  const remaining = status.detail;
  const stop = (reason: AutoContinuationStopReason) =>
    ({ type: "stop", reason, remaining }) as const;
  if (input.userStopped || input.runStatus === "interrupted" || input.runStatus === "cancelled")
    return stop("stopped");
  if (input.usageLimited) return stop("usage_limit");
  if (input.runStatus === "failed") return stop("failed");
  if (input.awaitingUser || input.runStatus === "waiting") return stop("awaiting_user");
  if (status.type === "blocked") return stop("blocked");
  if (input.continuationsSoFar > 0 && !input.madeProgress) return stop("no_progress");
  if (input.continuationsSoFar >= input.maxContinuations) return stop("limit_reached");
  return { type: "continue", remaining, continuation: input.continuationsSoFar + 1 };
}

export function autoContinuationPrompt(remaining: string): string {
  const left = remaining.length === 0 ? "" : `\n\nWhat remains, in your words: ${remaining}`;
  return `Continue toward the user's original request without waiting for them. Do the remaining work you can do yourself, within the permissions you already have.${left}`;
}

const STOP_EXPLANATIONS: Record<AutoContinuationStopReason, string> = {
  blocked: "The agent says it is blocked.",
  awaiting_user: "The agent is waiting for your answer, approval or input.",
  stopped: "The run was stopped.",
  failed: "The run ended with an error.",
  usage_limit: "A usage limit was reached.",
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
