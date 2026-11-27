import {
  AgentdApproval,
  AgentdCommandError,
  AgentdNotFoundError,
  AgentdStatus,
  AgentdTaskRow,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deriveEngineScreen, type EngineScreenInput } from "./engineScreen";

const decodeStatus = Schema.decodeUnknownSync(AgentdStatus);
const decodeTask = Schema.decodeUnknownSync(AgentdTaskRow);
const decodeApproval = Schema.decodeUnknownSync(AgentdApproval);

const status = (setUp: boolean) =>
  decodeStatus({
    version: "agentd v0.1.13 0d0b360a58c0",
    ok: setUp,
    setUp,
    teamServer: null,
    checks: [],
  });

const task = (id: string, fields: Partial<typeof AgentdTaskRow.Encoded> = {}) =>
  decodeTask({
    id,
    title: `Task ${id}`,
    state: "claimed",
    workerState: null,
    workerRunning: true,
    workerTool: "claude",
    runsOn: "local",
    project: "next",
    issue: null,
    started: null,
    branch: null,
    updated: null,
    ...fields,
  });

const approval = (id: string, handoff: string | null) =>
  decodeApproval({
    id,
    text: "Merge the pull request?",
    action: "merge",
    handoff,
    project: "next",
    ref: null,
    requiredRole: null,
    created: null,
  });

const ready = (input: Partial<EngineScreenInput>) => {
  const screen = deriveEngineScreen({
    status: status(true),
    tasks: [],
    approvals: [],
    canOperate: true,
    ...input,
  });
  if (screen.kind !== "ready") throw new Error(`expected ready, got ${screen.kind}`);
  return screen;
};

const notSetUp = { kind: "notSetUp", message: "Set up LibraOS Engine on your computer" };

describe("deriveEngineScreen", () => {
  it("asks to set up LibraOS Engine when it is missing or not set up, not an error", () => {
    const base = { tasks: "loading", approvals: "loading", canOperate: true } as const;
    expect(deriveEngineScreen({ ...base, status: status(false) })).toEqual(notSetUp);
    expect(
      deriveEngineScreen({
        ...base,
        status: new AgentdNotFoundError({ message: "agentd was not found" }),
      }),
    ).toEqual(notSetUp);
    expect(
      deriveEngineScreen({
        ...base,
        status: new AgentdCommandError({ message: "run agentd init", notSetUp: true }),
      }),
    ).toEqual(notSetUp);
    expect(
      deriveEngineScreen({
        ...base,
        status: new AgentdCommandError({ message: "ledger locked", notSetUp: false }),
      }),
    ).toEqual({ kind: "unreachable", message: "ledger locked" });
  });

  it("offers Stop only to a device that may operate, and never on finished work", () => {
    const tasks = [task("hof-aaaaaa"), task("hof-bbbbbb", { state: "done", workerRunning: false })];
    const stopFlags = (canOperate: boolean) =>
      ready({ tasks, canOperate }).sections.flatMap((section) =>
        section.tasks.map((item) => [item.id, item.canStop]),
      );
    expect(stopFlags(false)).toEqual([
      ["hof-aaaaaa", false],
      ["hof-bbbbbb", false],
    ]);
    expect(stopFlags(true)).toEqual([
      ["hof-aaaaaa", true],
      ["hof-bbbbbb", false],
    ]);
  });

  it("tells approvals that failed to load apart from no approvals", () => {
    expect(ready({ approvals: "error" }).approvals).toEqual({
      kind: "error",
      message: "Couldn't read approvals",
    });
    expect(ready({ approvals: [] }).approvals).toEqual({
      kind: "empty",
      message: "Nothing waits on you",
    });
  });

  it("puts a blocked task and one with a pending approval under Waiting on you, omitting empty sections", () => {
    const screen = ready({
      tasks: [
        task("hof-cccccc", { workerState: "blocked" }),
        task("hof-dddddd"),
        task("hof-eeeeee", { state: "offered", workerRunning: false, workerTool: null }),
      ],
      approvals: [approval("apr-1", "hof-dddddd")],
    });
    expect(
      screen.sections.map((section) => [section.title, section.tasks.map((item) => item.id)]),
    ).toEqual([
      ["Waiting on you", ["hof-cccccc", "hof-dddddd"]],
      ["Offered", ["hof-eeeeee"]],
    ]);
    expect(screen.approvals).toEqual({
      kind: "list",
      items: [{ id: "apr-1", title: "Merge the pull request?", detail: "Task hof-dddddd" }],
    });
  });
});
