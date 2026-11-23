import type { AgentdTaskRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentdIndicatorState,
  offerAccountLink,
  OFFER_AFTER_MS,
  parseDefaultBudget,
  projectHasRunningWorker,
  workerOffer,
  workerOfferSignal,
} from "./agentdVisibility.logic";

describe("agentdIndicatorState", () => {
  it.each([
    [null, null, "unknown"],
    [null, "AgentdNotFoundError", "not-installed"],
    [null, "AgentdCommandError", "attention"],
    [{ setUp: false, ok: true }, null, "not-set-up"],
    [{ setUp: true, ok: false }, null, "attention"],
    [{ setUp: true, ok: true }, null, "on"],
    // A later read that fails keeps agentd's last answer.
    [{ setUp: true, ok: true }, "AgentdCommandError", "on"],
  ] as const)("%j with %s reads %s", (status, failure, expected) => {
    expect(agentdIndicatorState(status, failure)).toBe(expected);
  });
});

describe("workerOfferSignal", () => {
  const base = { running: true, startedAtMs: 0, nowMs: 0, sentWhileRunning: false };
  it("fires after five minutes of one turn or a message sent while it runs", () => {
    expect(workerOfferSignal({ ...base, nowMs: OFFER_AFTER_MS - 1 })).toBe(false);
    expect(workerOfferSignal({ ...base, nowMs: OFFER_AFTER_MS })).toBe(true);
    expect(workerOfferSignal({ ...base, sentWhileRunning: true })).toBe(true);
    expect(workerOfferSignal({ ...base, startedAtMs: null, nowMs: OFFER_AFTER_MS })).toBe(false);
    expect(workerOfferSignal({ ...base, running: false, sentWhileRunning: true })).toBe(false);
  });
});

describe("workerOffer", () => {
  const base = {
    suggestWorkers: true,
    dismissedInThread: false,
    signal: true,
    codeThread: true,
    agentdSetUp: true,
    branch: null,
    workerRunning: false,
    cloudLinked: false,
  } as const;
  it("offers a local worker on a feature branch", () => {
    expect(workerOffer(base)).toBe("local");
  });
  it.each([
    ["offers are off", { suggestWorkers: false }],
    ["Not now in this thread", { dismissedInThread: true }],
    ["no signal", { signal: false }],
    ["a Chat thread", { codeThread: false }],
    ["agentd not set up", { agentdSetUp: false }],
    ["a folder that is not a git repository", { branch: "not-repo" }],
    ["git status unknown", { branch: undefined }],
    ["a worker already running", { workerRunning: true }],
    ["a detached head without a linked account", { branch: "detached" }],
  ] as const)("hides with %s", (_reason, change) => {
    expect(workerOffer({ ...base, ...change })).toBeNull();
  });
  it("names Cloud Workers on a detached head when the account is linked", () => {
    expect(workerOffer({ ...base, branch: "detached", cloudLinked: true })).toBe("cloud");
  });
  it("offers a local worker on main, and Cloud Workers too when the account is linked", () => {
    expect(workerOffer({ ...base, branch: "protected" })).toBe("local");
    expect(workerOffer({ ...base, branch: "protected", cloudLinked: true })).toBe("local-or-cloud");
  });
});

describe("projectHasRunningWorker", () => {
  const row = (fields: Partial<AgentdTaskRow>) =>
    ({ workerRunning: false, runsOn: "local", state: "offered", ...fields }) as AgentdTaskRow;
  it("counts running local workers and claimed team or cloud tasks of this project", () => {
    const mine = () => true;
    expect(projectHasRunningWorker([row({ workerRunning: true })], mine)).toBe(true);
    expect(projectHasRunningWorker([row({ runsOn: "cloud", state: "claimed" })], mine)).toBe(true);
    expect(projectHasRunningWorker([row({ state: "claimed" })], mine)).toBe(false);
    expect(projectHasRunningWorker([row({ workerRunning: true })], () => false)).toBe(false);
  });
});

describe("parseDefaultBudget", () => {
  it("reads minutes and dollars", () => {
    expect(parseDefaultBudget("60m,$5")).toEqual({ minutes: 60, dollars: 5 });
    expect(parseDefaultBudget("15m,$2.50")).toEqual({ minutes: 15, dollars: 2.5 });
    expect(parseDefaultBudget("$5")).toBeNull();
  });
});

describe("offerAccountLink", () => {
  it.each([
    [null, null],
    [undefined, null],
    [{ supported: true, problem: "setup" }, true],
    // Linked: an account key is installed, whatever else agentd reports.
    [{ supported: true, problem: null }, false],
    [{ supported: true, problem: "credit" }, false],
    [{ supported: true, problem: "balance" }, false],
    // This agentd has no Cloud Workers, so there is nothing to link.
    [{ supported: false, problem: "setup" }, false],
  ] as const)("%j offers the link step: %s", (account, expected) => {
    expect(offerAccountLink(account)).toBe(expected);
  });
});
