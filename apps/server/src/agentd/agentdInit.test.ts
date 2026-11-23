import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AgentdBridge from "./AgentdBridge.ts";
import { agentdStatus } from "./agentdJson.ts";
import { AgentdInit, initPhase, initPrompt, layer, terminalText } from "./agentdInit.ts";

describe("initPrompt", () => {
  it.each([
    ["Accept the AgentD End User Agreement 3.5? Type yes to accept: ", "eula"],
    ["Type yes to accept:", "eula"],
    ["Activation code: ", "other"],
    ["Route implementation through agentd? [Y/n] ", "other"],
    ["Continue?", "other"],
    ["Type yes to accept: yes", null],
    ["services  writing units", null],
    ["", null],
  ] as const)("%j asks %s", (line, asks) => {
    expect(initPrompt(line)).toBe(asks);
  });
});

describe("initPhase", () => {
  it.each([
    [0, null, "succeeded"],
    [3, null, "succeeded"],
    [1, null, "failed"],
    [2, null, "failed"],
    [null, "timeout", "failed"],
    [3, "prompt", "failed"],
  ] as const)("exit %s, stopped %s: %s", (exitCode, stopped, phase) => {
    expect(initPhase(exitCode, stopped)).toBe(phase);
  });
});

describe("terminalText", () => {
  it("drops colours, cursor moves and carriage returns", () => {
    expect(terminalText("\u001b[1meula\u001b[0m  ok\r\n\u001b]0;agentd\u0007next\r\n")).toBe(
      "eula  ok\nnext\n",
    );
  });
});

describe("agentdStatus setUp", () => {
  const doctor = (setUp: boolean, activation: string) => ({
    set_up: setUp,
    checks: [{ id: "activation", status: "optional", detail: activation }],
  });
  it.each([
    [true, "not linked to a LibraOS account (optional); EULA eula-draft-3.5 accepted", "3.5", true],
    [true, "not linked (optional); the EULA is not accepted on this machine yet", "3.5", false],
    [
      true,
      "not linked to a LibraOS account (optional); EULA eula-draft-3.4 accepted",
      "3.5",
      false,
    ],
    [true, "activated for the beta on 2026-11-01; EULA 3.5 accepted", null, true],
    [false, "not linked to a LibraOS account (optional); EULA 3.5 accepted", "3.5", false],
  ] as const)("set_up %s, %j, carrying %s: %s", (setUp, activation, carried, expected) => {
    expect(agentdStatus("agentd v0.1.13", doctor(setUp, activation), carried).setUp).toBe(expected);
  });
});

const ran = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// Go's flag package prints one dash; the EULA flag's check looks for its two-dash spelling.
const NEW_INIT_HELP = "  --accept-eula\n  -permission-mode string\n    \tguarded or yolo\n";
const OLD_INIT_HELP = "  --accept-eula\n  -route string\n";

function doctorJson(config: string) {
  return JSON.stringify({
    set_up: false,
    checks: [
      { id: "config", status: "pass", detail: config },
      {
        id: "activation",
        status: "optional",
        detail: "the EULA is not accepted on this machine yet",
      },
    ],
  });
}
const FRESH = "root /home/a/.agentd; no config.toml, so defaults";
const INSTALLED = "root /home/a/.agentd; /home/a/.agentd/config.toml parses";

/**
 * The service over a fake agentd (answers by argument list) and a fake terminal that records what
 * it ran, prints `printed` and exits with `exitCode`.
 */
function makeInit(
  answers: Record<string, string>,
  terminal: { exitCode: number; printed?: string } = { exitCode: 0 },
) {
  const spawned: Array<ReadonlyArray<string>> = [];
  const pty = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input.args ?? []);
        let onExit: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;
        let onData: ((data: string) => void) | null = null;
        queueMicrotask(() => {
          onData?.(terminal.printed ?? "");
          onExit?.({ exitCode: terminal.exitCode, signal: null });
        });
        return {
          pid: 1,
          write: () => {},
          resize: () => {},
          kill: () => {},
          onData: (callback) => {
            onData = callback;
            return () => {};
          },
          onExit: (callback) => {
            onExit = callback;
            return () => {};
          },
        };
      }),
  });
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    const key = input.args.join(" ");
    const answer = answers[key];
    return answer === undefined
      ? Effect.succeed(ran(`setting is not exposed: ${key}`, 1))
      : Effect.succeed(ran(answer));
  };
  const backgroundPolicy = BackgroundPolicy.BackgroundPolicy.of({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    snapshot: Effect.die("unused"),
    shouldRunScopeWork: () => Effect.succeed(true),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
  const service = Effect.gen(function* () {
    const bridge = yield* AgentdBridge.make();
    // Built in the test's scope: init's run is forked into it and outlives start.
    const context = yield* Layer.build(layer).pipe(
      Effect.provideService(AgentdBridge.AgentdBridge, bridge),
    );
    return Context.get(context, AgentdInit);
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(BackgroundPolicy.BackgroundPolicy, backgroundPolicy),
    Effect.provideService(PtyAdapter.PtyAdapter, pty),
    Effect.provideService(HostProcess.Environment, { AGENTD_BIN: process.execPath }),
    Effect.provideService(HostProcess.HomeDirectory, "/home/a"),
    Effect.provide(NodeServices.layer),
  );
  return { service, spawned };
}

const finished = (init: AgentdInit["Service"]) =>
  init.subscribe.pipe(
    Stream.filter((state) => state.phase !== "running" && state.phase !== "idle"),
    Stream.runHead,
  );

describe("AgentdInit permission mode", () => {
  const base = { version: "agentd v0.1.30\n", "doctor --json": doctorJson(FRESH) };

  it.effect.each([
    ["guarded", ["init", "--route", "on", "--accept-eula", "--permission-mode", "guarded"]],
    ["yolo", ["init", "--route", "on", "--accept-eula", "--permission-mode", "yolo"]],
  ] as const)("passes %s to agentd init at first setup", ([mode, argv]) =>
    Effect.gen(function* () {
      const fake = makeInit({ ...base, "init --help": NEW_INIT_HELP });
      const init = yield* fake.service;
      yield* init.start({ permissionMode: mode });
      yield* finished(init);
      expect(fake.spawned).toEqual([argv]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a first setup without a choice and starts nothing", () =>
    Effect.gen(function* () {
      const fake = makeInit({ ...base, "init --help": NEW_INIT_HELP });
      const init = yield* fake.service;
      const error = yield* Effect.flip(init.start({}));
      expect(error.message).toContain("Choose how much workers may do without asking");
      expect(fake.spawned).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("asks nothing of an installed agentd taking a new agreement", () =>
    Effect.gen(function* () {
      const fake = makeInit({
        ...base,
        "doctor --json": doctorJson(INSTALLED),
        "init --help": NEW_INIT_HELP,
      });
      const init = yield* fake.service;
      yield* init.start({});
      yield* finished(init);
      expect(fake.spawned).toEqual([["init", "--route", "on", "--accept-eula"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("says the choice was not passed to an agentd without the flag", () =>
    Effect.gen(function* () {
      const fake = makeInit({ ...base, "init --help": OLD_INIT_HELP });
      const init = yield* fake.service;
      const started = yield* init.start({ permissionMode: "yolo" });
      yield* finished(init);
      expect(started.permissionModeIgnored).toBe(true);
      expect(fake.spawned).toEqual([["init", "--route", "on", "--accept-eula"]]);
    }).pipe(Effect.scoped),
  );
});
