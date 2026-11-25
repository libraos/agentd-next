import { describe, expect, it } from "vite-plus/test";

import {
  agentdTaskApprovals,
  agentdTaskBelongsToProject,
  agentdTaskBudgetUse,
  agentdTaskSection,
  finishedAgentdTaskLabel,
  isFinishedAgentdTask,
  isQueuedAgentdTask,
  queuedAgentdTaskReason,
  queuedAgentdTaskWait,
  runningAgentdTaskLabel,
} from "./backgroundTasks.logic";

describe("background task states", () => {
  it.each([
    ["offered", null, false, "local", true],
    ["offered", null, true, "local", false],
    ["offered", "blocked", false, "local", false],
    ["offered", null, false, "cloud", false],
    ["blocked", null, false, "local", false],
    ["done", null, false, "local", false],
  ] as const)(
    "classifies %s / %s / %s / %s as queued: %s",
    (state, workerState, workerRunning, runsOn, queued) => {
      expect(isQueuedAgentdTask({ state, workerState, workerRunning, runsOn })).toBe(queued);
    },
  );

  it.each([
    [null, "Won't start on its own: no agent chosen"],
    ["Codex", "Waiting for a Codex worker"],
    ["Claude Code", "Waiting for a Claude Code worker"],
  ])("explains why a task with agent %s is queued", (worker, reason) => {
    expect(queuedAgentdTaskReason(worker)).toBe(reason);
  });

  it.each([
    [null, null, false],
    [-60_000, "Queued for less than a minute", false],
    [60_000, "Queued for 1 minute", false],
    [20 * 60_000, "Queued for 20 minutes", false],
    [2 * 3_600_000, "Queued for 2 hours", false],
    [86_400_000, "Queued for 1 day", false],
    [86_400_001, "Queued for 1 day", true],
    [4 * 86_400_000, "Queued for 4 days", true],
  ])("describes a wait of %s ms", (elapsed, label, long) => {
    const now = Date.UTC(2026, 10, 24);
    const created = elapsed === null ? null : new Date(now - elapsed).toISOString();
    expect(queuedAgentdTaskWait(created, now)).toEqual({ label, long });
  });

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

  const claimed = {
    id: "hof-123abc",
    state: "claimed",
    workerState: null,
    workerRunning: true,
    runsOn: "local",
  } as const;
  const approval = (handoff: string | null) => ({ id: "apr-1", handoff });

  it.each([
    ["no approval", "running", claimed, []],
    ["an approval for another task", "running", claimed, [approval("hof-999fff")]],
    ["an approval without a task", "running", claimed, [approval(null)]],
    ["its own approval", "waiting", claimed, [approval(claimed.id)]],
    [
      "its own approval while queued",
      "waiting",
      { ...claimed, state: "offered", workerRunning: false },
      [approval(claimed.id)],
    ],
    [
      "its own approval in the cloud",
      "running",
      { ...claimed, runsOn: "cloud" },
      [approval(claimed.id)],
    ],
    [
      "its own approval once done",
      "finished",
      { ...claimed, state: "done" },
      [approval(claimed.id)],
    ],
  ] as const)("lists a task with %s under %s", (_case, section, status, approvals) => {
    expect(agentdTaskSection(status, null, approvals)).toBe(section);
  });

  it("keeps only the task's own approvals", () => {
    const own = approval("hof-123abc");
    expect(
      agentdTaskApprovals([approval("hof-999fff"), own, approval(null)], "hof-123abc"),
    ).toEqual([own]);
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
