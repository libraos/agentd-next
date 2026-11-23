// agentd's dispatch refusal is prose today; these are the three forms that name the open task
// holding the directory or issue (dispatchguard.go in agentd). Anything else stays the raw reason.
const RUNNING = /already has a running \S+ worker on handoff (hof-[0-9a-f]+) \((\w+)/;
const CLAIMED = /already has handoff (hof-[0-9a-f]+), claimed by session/;
const ON_ISSUE = /already has open handoff (hof-[0-9a-f]+) \((\w+)\)/;

export interface BlockingRefusal {
  readonly id: string;
  readonly state: string;
  readonly running: boolean;
}

/** The open task a `dispatch refused` names, or null for any other refusal. */
export function blockingRefusal(message: string): BlockingRefusal | null {
  if (!message.includes("dispatch refused")) return null;
  const running = RUNNING.exec(message);
  if (running) return { id: running[1]!, state: running[2]!, running: true };
  const claimed = CLAIMED.exec(message);
  if (claimed) return { id: claimed[1]!, state: "claimed", running: false };
  const onIssue = ON_ISSUE.exec(message);
  if (onIssue) return { id: onIssue[1]!, state: onIssue[2]!, running: false };
  return null;
}
