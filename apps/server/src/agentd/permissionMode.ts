import type { AgentdPermissionMode, AgentdPermissionModeState } from "@t3tools/contracts";

// agentd init gained `--permission-mode guarded|yolo` (agentd-core#1021); older agentd has no flag.
export function initTakesPermissionMode(help: string): boolean {
  return /(?:^|\s)--?permission-mode\b/m.test(help);
}

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
}

function mode(value: unknown): AgentdPermissionMode | null {
  return value === "guarded" || value === "yolo" ? value : null;
}

function hasYolo(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((scoped) => scoped === "yolo")
  );
}

/** The mode from `agentd config get ... --json` for the global, role and repository settings. */
export function permissionModeState(
  global: string | null,
  roles: string | null,
  repos: string | null,
): AgentdPermissionModeState {
  return {
    mode: global === null ? null : mode(json(global)),
    scopedYolo: [roles, repos].some((stdout) => stdout !== null && hasYolo(json(stdout))),
  };
}

// `claude --bg` prints "backgrounded · <id> · claude attach <id>" at the top of the worker's log.
const CLAUDE_BACKGROUND_ID = /backgrounded · ([0-9a-f]{6,}) ·/;

/** How a person opens a blocked Claude worker's session; with its id when the log names it. */
export function claudeAttachCommand(logHead: string): string {
  const id = CLAUDE_BACKGROUND_ID.exec(logHead)?.[1];
  return id === undefined ? "claude attach" : `claude attach ${id}`;
}
