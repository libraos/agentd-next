import { describe, expect, it } from "vite-plus/test";

import {
  agentdTaskBelongsToProject,
  agentdTaskBudgetUse,
  finishedAgentdTaskLabel,
  isFinishedAgentdTask,
  runningAgentdTaskLabel,
} from "./backgroundTasks.logic";

describe("background task states", () => {
  it.each([
    ["offered", false],
    ["claimed", false],
    ["blocked", false],
    ["held", false],
    ["done", true],
    ["delivered", true],
    ["cancelled", true],
    ["declined", true],
  ])("classifies %s as finished: %s", (state, finished) => {
    expect(isFinishedAgentdTask(state)).toBe(finished);
  });

  it.each([
    ["done", "verified", "passed: pnpm test", "Verified"],
    ["done", "act", "passed: pnpm test", "Needs work"],
    ["done", "wait", "passed: pnpm test", "Needs work"],
    ["done", "act", "failed: pnpm test", "Failed"],
    ["done", "act", "timed_out: pnpm test", "Failed"],
    ["cancelled", "act", null, "Stopped"],
    ["declined", "act", null, "Failed"],
    ["done", null, null, "Result unavailable"],
  ])("describes %s with verdict %s and check %s as %s", (state, verdict, check, label) => {
    expect(finishedAgentdTaskLabel(state, verdict === null ? null : { verdict, check })).toBe(
      label,
    );
  });

  it.each([
    ["claimed", null, true, null, "Running"],
    ["claimed", "blocked", false, null, "Waiting for a person"],
    ["claimed", "waiting_answer", false, null, "Waiting for a person"],
    ["claimed", null, false, "budget_exceeded", "Waiting for a person"],
    ["claimed", "gone", false, null, "Worker exited"],
    ["claimed", "stopped", false, null, "Worker stopped"],
    ["offered", null, false, null, "Queued"],
    ["blocked", null, false, null, "Waiting for other tasks"],
    ["claimed", null, false, null, "Assigned"],
  ])(
    "describes %s / %s / %s / %s as %s",
    (state, workerState, workerRunning, budgetState, label) => {
      expect(runningAgentdTaskLabel({ state, workerState, workerRunning }, budgetState)).toBe(
        label,
      );
    },
  );
});

describe("agentdTaskBelongsToProject", () => {
  it("matches a fork by its checkout even when the project resolves to upstream", () => {
    const task = {
      workerCwd: "/home/me/agentd-desktop-next",
      project: "libraos/agentd-desktop-next",
    };
    expect(
      agentdTaskBelongsToProject(task, "/home/me/agentd-desktop-next", "pingdotgg/t3code"),
    ).toBe(true);
    expect(agentdTaskBelongsToProject(task, "/home/me/agentd-desktop-next/apps/web", null)).toBe(
      false,
    );
    expect(agentdTaskBelongsToProject(task, "/home/me/agentd-desktop", null)).toBe(false);
  });

  it("matches a checkout inside the project folder, and Windows paths without case", () => {
    expect(
      agentdTaskBelongsToProject(
        { workerCwd: "/home/me/mono/pkg", project: null },
        "/home/me/mono/",
        null,
      ),
    ).toBe(true);
    expect(
      agentdTaskBelongsToProject(
        { workerCwd: "C:\\Users\\Me\\Repo", project: null },
        "c:/users/me/repo",
        null,
      ),
    ).toBe(true);
  });

  it("falls back to the repository when agentd reports no checkout", () => {
    expect(
      agentdTaskBelongsToProject({ project: "LibraOS/Site" }, "/home/me/site", "libraos/site"),
    ).toBe(true);
    expect(agentdTaskBelongsToProject({ project: "libraos/site" }, "/home/me/site", null)).toBe(
      false,
    );
  });
});

describe("agentd task budget use", () => {
  const running = { finished: false, state: "claimed", verdict: null, budgetState: null };
  const minutes = (n: number) => n * 60_000;

  it("takes the larger of time and money used", () => {
    expect(
      agentdTaskBudgetUse({ ...running, budget: "90m,$15", elapsedMs: minutes(52), costUsd: 2.1 }),
    ).toEqual({ fraction: 52 / 90, tone: "progress" });
    expect(
      agentdTaskBudgetUse({ ...running, budget: "90m,$15", elapsedMs: minutes(10), costUsd: 12 }),
    ).toEqual({ fraction: 0.8, tone: "progress" });
  });

  it("warns from 85% and caps at the whole budget", () => {
    expect(
      agentdTaskBudgetUse({ ...running, budget: "90m", elapsedMs: minutes(80), costUsd: null }),
    ).toEqual({ fraction: 80 / 90, tone: "warning" });
    expect(
      agentdTaskBudgetUse({ ...running, budget: "$5", elapsedMs: minutes(1), costUsd: 6 }),
    ).toEqual({ fraction: 1, tone: "warning" });
  });

  it("fills the bar when the task ends", () => {
    const ended = { budget: "30m", elapsedMs: minutes(5), costUsd: 1, budgetState: null };
    expect(
      agentdTaskBudgetUse({
        ...ended,
        finished: true,
        state: "done",
        verdict: { verdict: "verified", check: "passed" },
      }),
    ).toEqual({ fraction: 1, tone: "success" });
    expect(
      agentdTaskBudgetUse({
        ...ended,
        finished: true,
        state: "done",
        verdict: { verdict: "act", check: "failed: exit 1" },
      }),
    ).toEqual({ fraction: 1, tone: "failure" });
    expect(
      agentdTaskBudgetUse({ ...ended, finished: true, state: "cancelled", verdict: null }),
    ).toEqual({ fraction: 1, tone: "warning" });
  });

  it("has no bar without a budget", () => {
    expect(
      agentdTaskBudgetUse({ ...running, budget: null, elapsedMs: minutes(5), costUsd: 1 }),
    ).toBeNull();
  });
});
