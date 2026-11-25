import type { AgentdTaskRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentdIndicatorState,
  offerAccountLink,
  OFFER_AFTER_MS,
  parseDefaultBudget,
  projectHasRunningWorker,
  showFirstTaskCard,
  workerOffer,
  workerOfferSignal,
  workerReadiness,
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

describe("workerReadiness", () => {
  const pass = (id: string) => ({ id, status: "pass", detail: null, fix: null });
  const loggedOut = {
    id: "claude-login",
    status: "fail",
    detail: "not logged in, and neither is codex",
    fix: "claude auth login",
  };
  const status = {
    checks: [pass("binary"), pass("claude-login"), pass("codex-login")],
    defaultWorker: "claude",
    missingSkills: [],
  } as const;
  const base = { engine: "on", status, isRepo: true } as const;

  it("is ready only when the engine, the worker's sign-in and the repository all hold", () => {
    expect(workerReadiness(base)).toEqual({ kind: "ready", missingSkills: [] });
    expect(workerReadiness({ ...base, isRepo: false })).toEqual({
      kind: "setup-required",
      missing: "repository",
    });
    expect(
      workerReadiness({ ...base, status: { ...status, checks: [pass("binary"), loggedOut] } }),
    ).toEqual({ kind: "setup-required", missing: "sign-in", worker: "claude", check: loggedOut });
  });

  it.each([
    ["not-installed", { kind: "setup-required", missing: "engine", engine: "not-installed" }],
    ["not-set-up", { kind: "setup-required", missing: "engine", engine: "not-set-up" }],
    ["unknown", { kind: "unknown" }],
  ] as const)("names an engine that is %s", (engine, expected) => {
    expect(workerReadiness({ ...base, engine, status: null })).toEqual(expected);
  });

  it("fails on a failing required check with agentd's fix, or when agentd does not answer", () => {
    const server = { id: "server", status: "fail", detail: "device revoked", fix: "join again" };
    expect(
      workerReadiness({ ...base, engine: "attention", status: { ...status, checks: [server] } }),
    ).toEqual({ kind: "setup-failed", missing: "engine", check: server });
    expect(workerReadiness({ ...base, engine: "attention", status: null })).toEqual({
      kind: "setup-failed",
      missing: "engine",
    });
  });

  it("checks the chosen worker's sign-in, and none for Cloud Workers", () => {
    const codexOut = {
      id: "codex-login",
      status: "optional",
      detail: "not logged in",
      fix: "codex login",
    };
    const mixed = { ...status, checks: [pass("claude-login"), codexOut] };
    expect(workerReadiness({ ...base, status: mixed })).toMatchObject({ kind: "ready" });
    expect(workerReadiness({ ...base, status: mixed, worker: "codex" })).toMatchObject({
      missing: "sign-in",
      worker: "codex",
    });
    expect(workerReadiness({ ...base, status: mixed, worker: "codex", cloud: true })).toMatchObject(
      { kind: "ready" },
    );
    expect(workerReadiness({ ...base, status: { ...status, defaultWorker: null } })).toMatchObject({
      missing: "sign-in",
      worker: null,
    });
  });

  it("warns about missing Skills without blocking, for the default worker only", () => {
    const skills = { ...status, missingSkills: ["agentd-setup"] };
    expect(workerReadiness({ ...base, status: skills })).toEqual({
      kind: "ready",
      missingSkills: ["agentd-setup"],
    });
    const opencode = { ...skills, checks: [...skills.checks, pass("opencode-worker")] };
    expect(workerReadiness({ ...base, status: opencode, worker: "opencode" })).toEqual({
      kind: "ready",
      missingSkills: [],
    });
  });

  it("waits for the project's git status, and judges the machine alone with no project", () => {
    expect(workerReadiness({ ...base, isRepo: null })).toEqual({ kind: "unknown" });
    expect(workerReadiness({ ...base, isRepo: undefined })).toMatchObject({ kind: "ready" });
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

describe("showFirstTaskCard", () => {
  const shows = {
    neverShowAgain: false,
    hiddenThisSession: false,
    codeThread: true,
    agentdOn: true,
    isRepo: true,
  } as const;

  it.each([
    [{}, true],
    [{ hiddenThisSession: true }, false],
    [{ neverShowAgain: true }, false],
    [{ agentdOn: false }, false],
    [{ codeThread: false }, false],
    [{ isRepo: undefined }, false],
    [{ isRepo: false }, false],
  ] as const)("%j shows the card: %s", (change, expected) => {
    expect(showFirstTaskCard({ ...shows, ...change })).toBe(expected);
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
