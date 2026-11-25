import { describe, expect, it } from "@effect/vitest";

import {
  estimateType,
  readDollarBudgets,
  readEstimate,
  readMaxWorkers,
  suggestCheck,
} from "./taskDefaults.ts";

// Recorded from agentd (`handoff estimate --type implement --json`), trimmed.
const ESTIMATE = `{"bench":0,"high":4.98,"label":"implementation","low":1.78,"median":3.11,"n":846,"type":"implement","workers":846}`;

describe("estimateType", () => {
  it("uses the draft's size and implement when it has none", () => {
    expect(estimateType("small")).toBe("small");
    expect(estimateType("complex")).toBe("complex");
    expect(estimateType("")).toBe("implement");
  });
});

describe("readEstimate", () => {
  it("reads agentd's range and refuses too small a sample or no answer", () => {
    expect(readEstimate(ESTIMATE, "implement")).toEqual({
      type: "implement",
      low: 1.78,
      median: 3.11,
      high: 4.98,
      jobs: 846,
    });
    expect(readEstimate(`{"low":0,"median":0,"high":0,"n":3}`, "small")).toBeNull();
    expect(readEstimate(`{"low":1,"high":2,"n":4}`, "small")).toBeNull();
    expect(readEstimate("no estimate (small fix or test, 2 past jobs)", "small")).toBeNull();
  });
});

describe("readDollarBudgets", () => {
  it("is true only when agentd lists at least one model price", () => {
    expect(readDollarBudgets("{}\n")).toBe(false);
    expect(
      readDollarBudgets(
        `{\n "claude-sonnet-5-5": {\n  "cache_read": 0.3,\n  "cache_write": 3.75,\n  "input": 3,\n  "output": 15\n }\n}\n`,
      ),
    ).toBe(true);
    expect(readDollarBudgets("error: setting is not exposed: budget.prices")).toBeNull();
  });
});

describe("readMaxWorkers", () => {
  it("reads a positive count and nothing else", () => {
    expect(readMaxWorkers("2\n")).toBe(2);
    expect(readMaxWorkers("0\n")).toBeNull();
    expect(readMaxWorkers("")).toBeNull();
    expect(readMaxWorkers("2.5")).toBeNull();
  });
});

describe("suggestCheck", () => {
  const files = (names: ReadonlyArray<string>, packageJson: string | null = null) => ({
    packageJson,
    has: (name: string) => names.includes(name),
  });
  it.each([
    [files(["package.json", "pnpm-lock.yaml"], `{"scripts":{"test":"vitest"}}`), "pnpm test"],
    [files(["package.json", "yarn.lock"], `{"scripts":{"test":"jest"}}`), "yarn test"],
    [files(["package.json", "bun.lock"], `{"scripts":{"test":"bun test"}}`), "bun run test"],
    [
      files(["package.json"], `{"packageManager":"pnpm@9.1.0","scripts":{"test":"x"}}`),
      "pnpm test",
    ],
    [files(["package.json"], `{"scripts":{"test":"node --test"}}`), "npm test"],
    [
      files(
        ["package.json", "go.mod"],
        `{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}`,
      ),
      "go test ./...",
    ],
    [files(["package.json", "Cargo.toml"], "not json"), "cargo test"],
    [files(["go.mod", "Cargo.toml"]), "go test ./..."],
    [files(["Cargo.toml"]), "cargo test"],
    [files(["pyproject.toml"]), "pytest"],
    [files([]), null],
  ])("suggests a check from the project files (%#)", (input, check) => {
    expect(suggestCheck(input)).toBe(check);
  });
});
