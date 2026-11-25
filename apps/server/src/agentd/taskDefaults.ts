import type { AgentdTaskEstimate, AgentdTaskSize } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// What a Start begins with when the person has not said: agentd's estimate for the task's size and
// a check command suggested from the project's own files.

export function estimateType(size: AgentdTaskSize): AgentdTaskEstimate["type"] {
  return size === "" ? "implement" : size;
}

const estimateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      low: Schema.optionalKey(Schema.Number),
      median: Schema.optionalKey(Schema.Number),
      high: Schema.optionalKey(Schema.Number),
      n: Schema.optionalKey(Schema.Number),
    }),
  ),
);
// agentd gives no estimate below this many priced past jobs; its JSON then carries zero amounts.
const ESTIMATE_MIN_JOBS = 5;

/** `agentd handoff estimate --type TYPE` output; null when agentd has no estimate for it. */
export function readEstimate(
  stdout: string,
  type: AgentdTaskEstimate["type"],
): AgentdTaskEstimate | null {
  const parsed = estimateJson(stdout);
  if (parsed._tag === "None") return null;
  const { low, median, high, n } = parsed.value;
  if (
    low === undefined ||
    high === undefined ||
    n === undefined ||
    n < ESTIMATE_MIN_JOBS ||
    !Number.isFinite(high) ||
    high <= 0 ||
    low < 0 ||
    low > high
  ) {
    return null;
  }
  return { type, low, median: median ?? low, high, jobs: n };
}

const pricesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * `agentd config get budget.prices`: whether any model has a price, which agentd needs before it
 * takes a dollar budget for a local worker. Null when the output is not a price table.
 */
export function readDollarBudgets(stdout: string): boolean | null {
  const parsed = pricesJson(stdout);
  return parsed._tag === "None" ? null : Object.keys(parsed.value).length > 0;
}

/** `agentd config get dispatch.max_workers`: how many local workers may run at once, else null. */
export function readMaxWorkers(stdout: string): number | null {
  const text = stdout.trim();
  if (!/^\d+$/.test(text)) return null;
  const max = Number(text);
  return max > 0 ? max : null;
}

const packageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      packageManager: Schema.optionalKey(Schema.String),
    }),
  ),
);
// `npm init` writes this test script; it fails on purpose.
const NPM_PLACEHOLDER = /no test specified/;

export interface ProjectFiles {
  /** package.json's text, when the file exists. */
  readonly packageJson: string | null;
  readonly has: (name: string) => boolean;
}

export const PROJECT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
] as const;

function packageRunner(files: ProjectFiles, packageManager: string | undefined): string {
  const named = packageManager?.split("@")[0];
  if (named === "pnpm" || named === "yarn" || named === "bun") return named;
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  return "npm";
}

/** A check command from the files at the project's root, in this order; null when none fits. */
export function suggestCheck(files: ProjectFiles): string | null {
  if (files.packageJson !== null) {
    const parsed = packageJson(files.packageJson);
    const test = parsed._tag === "Some" ? parsed.value.scripts?.test : undefined;
    if (typeof test === "string" && test.trim() !== "" && !NPM_PLACEHOLDER.test(test)) {
      const runner = packageRunner(
        files,
        parsed._tag === "Some" ? parsed.value.packageManager : undefined,
      );
      // `bun test` is bun's own runner, not the script.
      return runner === "bun" ? "bun run test" : `${runner} test`;
    }
  }
  if (files.has("go.mod")) return "go test ./...";
  if (files.has("Cargo.toml")) return "cargo test";
  if (files.has("pyproject.toml")) return "pytest";
  return null;
}
