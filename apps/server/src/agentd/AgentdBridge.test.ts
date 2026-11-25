import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AgentdBridge from "./AgentdBridge.ts";
import {
  RESERVE_ATTEMPT,
  attemptRecord,
  releaseRecord,
  reserveRecord,
  submissionFingerprint,
} from "./agentdCloudSubmissions.ts";

// Recorded from agentd v0.1.13 (`handoff list --json`, `handoff show ID --json`, `doctor --json`),
// trimmed; unknown keys stay to show they are ignored.
const LIST_JSON = `[
 {
  "a2a_state": "working",
  "check": "vp run check:changed",
  "claimer": "codex-615065aa16",
  "claimer_user": "alice",
  "from": "claude-67a65e011e",
  "goal": "Implement libraos/agentd-desktop-next#16: Offer Claude Code, Codex and opencode",
  "id": "hof-b449178313",
  "issue": "libraos/agentd-desktop-next#16",
  "origin": { "dir": "/home/alice/src/agentd-desktop", "tool": "claude" },
  "project": "libraos/agentd-desktop-next",
  "report": { "next_due": "2026-11-18T09:08:31+00:00" },
  "state": "claimed",
  "to_user": null,
  "updated": "2026-11-18T08:54:30+00:00",
  "version": 2,
  "worker_running": true,
  "worker_state": null
 },
 {
  "a2a_state": "completed",
  "claimer": "claude-8c11cb50d2",
  "goal": "Implement acme/api#897 (read it first: gh issue view 897 -R acme/api): in the weekly report, spli",
  "id": "hof-a6e5f4e329",
  "issue": "acme/api#897",
  "project": "acme/api",
  "state": "done",
  "title": "Weekly report: split retries by cause",
  "updated": "2026-11-18T06:47:57+00:00",
  "version": 3,
  "worker_state": null
 }
]`;

const SHOW_JSON = `{
 "a2a_state": "completed",
 "accept": ["A done with a passed check", "B created on the same PR after it merged: A is redone"],
 "body": { "goal": "Implement acme/api#897", "keep": "reverted stays a false accept" },
 "budget": "120m,$12",
 "budget_state": null,
 "check_cmd": "npm test -- report",
 "cloud_state": null,
 "cost": {
  "inference": { "usd": 2.87 },
  "total": { "estimate": true, "inference_usd": 2.87, "lines": 1, "partial": false, "usd": 2.87 }
 },
 "created": "2026-11-18T06:24:58+00:00",
 "dispatched": "2026-11-18T06:25:04+00:00",
 "id": "hof-a6e5f4e329",
 "lease_branch": null,
 "lease_device": null,
 "project": "acme/api",
 "state": "done",
 "title": null,
 "updated": "2026-11-18T06:47:57+00:00",
 "verdict": {
  "check": "passed: npm test -- report",
  "delivery": "unmerged: 18 commit(s) on agentd/hof-a6e5f4e329 not in main",
  "next": "verified: merge it as it is.",
  "verdict": "verified"
 },
 "worker_branch": "agentd/hof-a6e5f4e329",
 "worker_log": "/data/agentd/.state/dispatch/hof-a6e5f4e329-20261118T062504.log",
 "worker_note": null,
 "worker_state": "",
 "worker_tool": "claude"
}`;

const DOCTOR_JSON = `{
 "checks": [
  { "id": "binary", "status": "pass", "detail": "agentd v0.1.13 0d0b360a58c0" },
  { "id": "opencode", "status": "optional", "detail": "not found; agentd works without it", "fix": "install opencode" },
  { "id": "model-prices", "status": "warn", "detail": "unpriced models" },
  { "id": "server", "status": "fail", "detail": "https://team.example:8443/agentd: device dev-123 (cli, person Les): device revoked", "fix": "join with a new ticket" }
 ],
 "ok": false,
 "set_up": true
}`;

const SUBMISSION = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/;
const MARKER =
  /^desktop-cloud-[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12} [a-f0-9]{64}$/;

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const backgroundPolicy = BackgroundPolicy.BackgroundPolicy.of({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.die("unused"),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeBridge = (env: NodeJS.ProcessEnv, run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  AgentdBridge.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(BackgroundPolicy.BackgroundPolicy, backgroundPolicy),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provide(NodeServices.layer),
  );

// agentd's cloud submission records as `pin list/add --session` and `find` keep them, and the
// handoffs its offers created, for tests that cross several Starts.
function cloudLedger() {
  const pins: Array<{ session: string; text: string }> = [];
  const handoffs = new Map<string, Record<string, unknown>>();
  const record = (args: ReadonlyArray<string>, id: string, cloudState: string) => {
    const marker = args[args.indexOf("--state") + 1];
    handoffs.set(id, { id, state: "claimed", cloud_state: cloudState, body: { state: marker } });
  };
  const answer = (args: ReadonlyArray<string>): ProcessRunner.ProcessRunOutput | null => {
    const session = args[args.indexOf("--session") + 1] ?? "";
    switch (args[0] === "find" ? "find" : args.slice(0, 2).join(" ")) {
      case "pin list":
        return output(JSON.stringify(pins.filter((pin) => pin.session === session)));
      case "pin add":
        pins.push({ session, text: args[2]! });
        return output("{}");
      case "find": {
        const marker = args[1]!.slice(1, -1);
        const hits = [...handoffs.values()].filter((show) =>
          (show.body as { state: string }).state.includes(marker),
        );
        return output(JSON.stringify(hits.map((show) => ({ kind: "handoff", ref: show.id }))));
      }
      case "handoff show": {
        const show = handoffs.get(args[2]!);
        return show === undefined ? output("no such handoff", 1) : output(JSON.stringify(show));
      }
      default:
        return null;
    }
  };
  return { pins, handoffs, record, answer };
}

describe("AgentdBridge", () => {
  it.effect("serves agentd's status, task list and task through the contract schemas", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const fs = yield* FileSystem.FileSystem;
      const recordPath = `${yield* fs.makeTempDirectoryScoped()}/agentd-install.json`;
      yield* fs.writeFileString(
        recordPath,
        '{"action":"installed","path":"~/.local/bin/agentd","directory":"~/.local/bin",' +
          '"onPath":false,"pathLine":"export PATH=\\"~/.local/bin:$PATH\\"","skills":[]}\n',
      );
      const env = { AGENTD_BIN: process.execPath, AGENTD_DESKTOP_INSTALL_RECORD: recordPath };
      // opencode reads agentd's Skills from Claude Code's folder too; one of the two is there.
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${home}/.claude/skills/agentd`, { recursive: true });
      yield* fs.writeFileString(`${home}/.claude/skills/agentd/SKILL.md`, "# agentd\n");
      const bridge = yield* makeBridge(env, (input) => {
        calls.push(input.args);
        const key = input.args.join(" ");
        if (key === "version") return Effect.succeed(output("agentd v0.1.13 0d0b360a58c0\n"));
        // doctor exits 1 when a check fails and still prints its report.
        if (key === "doctor --json") return Effect.succeed(output(DOCTOR_JSON, 1));
        if (key === "config get dispatch.default_tool")
          return Effect.succeed(output("opencode\r\n"));
        // agentd prints an empty table while no model has a price.
        if (key === "config get budget.prices") return Effect.succeed(output("{}\n"));
        if (key === "config get dispatch.max_workers") return Effect.succeed(output("2\n"));
        if (key === "handoff list --limit 20 --json") return Effect.succeed(output(LIST_JSON));
        if (key === "handoff show hof-a6e5f4e329 --json") return Effect.succeed(output(SHOW_JSON));
        return Effect.die(`unexpected agentd ${key}`);
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      expect(yield* bridge.status).toEqual({
        version: "agentd v0.1.13 0d0b360a58c0",
        ok: false,
        setUp: true,
        defaultWorker: "opencode",
        dollarBudgets: false,
        maxWorkers: 2,
        missingSkills: ["agentd-setup"],
        cpuCount: NodeOS.availableParallelism(),
        teamServer: "https://team.example:8443/agentd",
        firstSetup: false,
        checks: [
          { id: "binary", status: "pass", detail: "agentd v0.1.13 0d0b360a58c0", fix: null },
          {
            id: "opencode",
            status: "optional",
            detail: "not found; agentd works without it",
            fix: "install opencode",
          },
          { id: "model-prices", status: "warn", detail: "unpriced models", fix: null },
          {
            id: "server",
            status: "fail",
            detail:
              "https://team.example:8443/agentd: device dev-123 (cli, person Les): device revoked",
            fix: "join with a new ticket",
          },
        ],
        binary: process.execPath,
        install: {
          action: "installed",
          path: "~/.local/bin/agentd",
          directory: "~/.local/bin",
          onPath: false,
          pathLine: 'export PATH="~/.local/bin:$PATH"',
          skills: [],
        },
      });

      const first = yield* Stream.runHead(bridge.subscribeTasks);
      expect(first._tag === "Some" ? first.value : null).toEqual([
        {
          id: "hof-b449178313",
          title: "Implement libraos/agentd-desktop-next#16: Offer Claude Code, Codex and opencode",
          state: "claimed",
          workerState: null,
          workerRunning: true,
          a2aState: "working",
          workerTool: "codex",
          workerName: "alice",
          runsOn: "local",
          project: "libraos/agentd-desktop-next",
          issue: "libraos/agentd-desktop-next#16",
          started: null,
          branch: null,
          updated: "2026-11-18T08:54:30+00:00",
        },
        {
          id: "hof-a6e5f4e329",
          title: "Weekly report: split retries by cause",
          state: "done",
          workerState: null,
          workerRunning: false,
          a2aState: "completed",
          workerTool: "claude",
          workerName: "claude-8c11cb50d2",
          runsOn: "local",
          project: "acme/api",
          issue: "acme/api#897",
          started: null,
          branch: null,
          updated: "2026-11-18T06:47:57+00:00",
        },
      ]);

      expect(yield* bridge.task({ id: "hof-a6e5f4e329" })).toEqual({
        id: "hof-a6e5f4e329",
        title: "Implement acme/api#897",
        goal: "Implement acme/api#897",
        state: "done",
        workerState: null,
        workerTool: "claude",
        runsOn: "local",
        accept: [
          "A done with a passed check",
          "B created on the same PR after it merged: A is redone",
        ],
        check: "npm test -- report",
        verdict: {
          verdict: "verified",
          check: "passed: npm test -- report",
          delivery: "unmerged: 18 commit(s) on agentd/hof-a6e5f4e329 not in main",
          next: "verified: merge it as it is.",
        },
        costUsd: 2.87,
        costEstimate: true,
        budget: "120m,$12",
        budgetState: null,
        branch: "agentd/hof-a6e5f4e329",
        note: null,
        project: "acme/api",
        hasLog: true,
        started: "2026-11-18T06:25:04+00:00",
        created: "2026-11-18T06:24:58+00:00",
        updated: "2026-11-18T06:47:57+00:00",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says what a blocked Claude worker waits for and how to attach to it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const log = `${yield* fs.makeTempDirectoryScoped()}/hof-a6e5f4e329.log`;
      yield* fs.writeFileString(log, "backgrounded · 4f1e2d3c4b · claude attach 4f1e2d3c4b\n");
      const blocked = JSON.stringify({
        ...JSON.parse(SHOW_JSON),
        state: "claimed",
        worker_state: "blocked",
        worker_wait: "permission prompt: Bash(npm install)",
        worker_log: log,
      });
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) =>
        input.args.join(" ") === "handoff show hof-a6e5f4e329 --json"
          ? Effect.succeed(output(blocked))
          : Effect.die(`unexpected agentd ${input.args.join(" ")}`),
      );
      const task = yield* bridge.task({ id: "hof-a6e5f4e329" });
      expect(task.waitingFor).toBe("permission prompt: Bash(npm install)");
      expect(task.attachCommand).toBe("claude attach 4f1e2d3c4b");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lowers the permission mode with the fixed guarded value and reads it back", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let mode = "yolo";
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        calls.push(key);
        switch (key) {
          case "config set dispatch.permission_mode guarded":
            mode = "guarded";
            return Effect.succeed(output('{"changed":true}\n'));
          case "config get dispatch.permission_mode --json":
            return Effect.succeed(output(`"${mode}"\n`));
          case "config get dispatch.permission_mode_roles --json":
            return Effect.succeed(output("{}\n"));
          case "config get dispatch.permission_mode_repos --json":
            return Effect.succeed(output('{"/src/app":"yolo"}\n'));
          default:
            return Effect.die(`unexpected agentd ${key}`);
        }
      });
      expect(yield* bridge.permissionMode).toEqual({ mode: "yolo", scopedYolo: true });
      expect(yield* bridge.lowerPermissionMode).toEqual({ mode: "guarded", scopedYolo: true });
      expect(calls.filter((call) => call.startsWith("config set"))).toEqual([
        "config set dispatch.permission_mode guarded",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sets the local worker limit with the number given", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        calls.push(key);
        if (key === "config set dispatch.max_workers 3") return Effect.succeed(output(""));
        return Effect.die(`unexpected agentd ${key}`);
      });
      yield* bridge.setMaxWorkers(3);
      expect(calls).toEqual(["config set dispatch.max_workers 3"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports agentd's refusal to lower the mode and an agentd without the setting", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        if (key === "config set dispatch.permission_mode guarded")
          return Effect.succeed({
            ...output("", 1),
            stderr:
              "agentd config set dispatch.permission_mode refused: CLAUDECODE is set, so this shell is an agent's\n",
          });
        if (key.startsWith("config get "))
          return Effect.succeed({ ...output("", 1), stderr: "setting is not exposed\n" });
        return Effect.die(`unexpected agentd ${key}`);
      });
      const error = yield* Effect.flip(bridge.lowerPermissionMode);
      expect(error.message).toContain("CLAUDECODE is set");
      expect(yield* bridge.permissionMode).toEqual({ mode: null, scopedYolo: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // doctor's Go-quoted detail for a registration whose command moved, per platform's path form.
  it.effect.each([
    String.raw`server agentd runs "C:\\Program Files\\AgentD\\resources\\bin\\agentd.exe", which is not there`,
    'server agentd runs "/opt/AgentD/resources/bin/agentd", which is not there',
    'server agentd runs "/Applications/AgentD.app/Contents/Resources/bin/agentd", which is not there',
  ])("connects an agent once whose registration runs a command that is gone: %s", (stale) =>
    Effect.gen(function* () {
      const doctor = (claude: string, codex: string, opencode: string) =>
        output(
          JSON.stringify({
            set_up: true,
            checks: [
              { id: "claude-mcp", status: claude === "pass" ? "pass" : "fail", detail: claude },
              { id: "codex-mcp", status: codex === "pass" ? "pass" : "fail", detail: codex },
              { id: "opencode-mcp", status: "fail", detail: opencode },
            ],
          }),
          1,
        );
      const neverRegistered = "agentd is not registered in ~/.config/opencode/opencode.json";
      let claudeFixed = false;
      let doctorReads = 0;
      const calls: string[] = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        calls.push(key);
        switch (key) {
          case "version":
            return Effect.succeed(output("agentd v0.1.20\n"));
          case "doctor --json":
            doctorReads += 1;
            return Effect.succeed(doctor(claudeFixed ? "pass" : stale, stale, neverRegistered));
          case "connect claude":
            claudeFixed = true;
            return Effect.succeed(output("registered MCP server agentd"));
          case "connect codex":
            return Effect.succeed(output("agentd: ~/.codex/config.toml is not writable", 1));
          case "config get dispatch.default_tool":
            return Effect.succeed(output("claude\n"));
          case "config get budget.prices":
            return Effect.succeed(output("{}\n"));
          // An agentd older than the setting: the form leaves out its worker count.
          case "config get dispatch.max_workers":
            return Effect.succeed(output("error: setting is not exposed: dispatch.max_workers", 1));
          default:
            return Effect.die(`unexpected agentd ${key}`);
        }
      });

      const first = yield* bridge.status;
      expect(first.maxWorkers).toBeNull();
      expect(calls.filter((call) => call.startsWith("connect"))).toEqual([
        "connect claude",
        "connect codex",
      ]);
      expect(doctorReads).toBe(2);
      expect(first.checks.map((check) => [check.id, check.status])).toEqual([
        ["claude-mcp", "pass"],
        ["codex-mcp", "fail"],
        ["opencode-mcp", "fail"],
      ]);

      // codex's failed repair is not tried again in this server run.
      const second = yield* bridge.status;
      expect(calls.filter((call) => call.startsWith("connect"))).toHaveLength(2);
      expect(doctorReads).toBe(3);
      expect(second.checks.find((check) => check.id === "codex-mcp")?.detail).toBe(stale);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a registration alone whose command is there or that was never made", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        calls.push(key);
        if (key === "version") return Effect.succeed(output("agentd v0.1.20\n"));
        if (key === "doctor --json")
          return Effect.succeed(
            output(
              JSON.stringify({
                set_up: true,
                checks: [
                  {
                    id: "claude-mcp",
                    status: "pass",
                    detail: "server agentd runs /usr/local/bin/agentd",
                  },
                  {
                    id: "codex-mcp",
                    status: "fail",
                    detail: "agentd is not registered in ~/.codex/config.toml",
                  },
                  {
                    id: "claude-hooks",
                    status: "fail",
                    detail: "hooks in ~/.claude/settings.json run /gone/agentd, which is not there",
                  },
                ],
              }),
              1,
            ),
          );
        if (key === "config get dispatch.default_tool") return Effect.succeed(output("claude\n"));
        if (key === "config get budget.prices") return Effect.succeed(output("{}\n"));
        if (key === "config get dispatch.max_workers") return Effect.succeed(output("4\n"));
        return Effect.die(`unexpected agentd ${key}`);
      });
      yield* bridge.status;
      expect(
        calls.filter((call) => call.startsWith("connect") || call === "doctor --json"),
      ).toEqual(["doctor --json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists people without node cards when agentd has no team server", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        switch (input.args.join(" ")) {
          case "user list --json":
            return Effect.succeed(output(`[{"name":"Les","role":"owner"}]`));
          case "server nodes --json":
            return Effect.succeed(
              output(
                "agentd: agentd server is part of the team server, which the public agentd does not include (LibraOS Team or Enterprise: https://libraos.com/pricing/)",
                2,
              ),
            );
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const read = yield* bridge.people({ includeNodes: true });
      expect(read.people.map((person) => person.name)).toEqual(["Les"]);
      expect(read.nodes).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves requesters and node cards and names leased and cloud work", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        switch (input.args.join(" ")) {
          case "user list --json":
            return Effect.succeed(output(`[{"name":"Les","role":"owner"}]`));
          case "server nodes --json":
            return Effect.succeed(
              output(
                `[{"name":"build-box","host":"runner-2","state":"busy","why":"Building locally","person":"Les","offline":false,"seen":"2026-11-18T09:14:00Z"}]`,
              ),
            );
          case "approval list --state pending --json":
            return Effect.succeed(
              output(`[{"id":"ap-01","text":"Raise the budget?","session":"codex-abc"}]`),
            );
          case "inbox list --mine --json":
            return Effect.succeed(
              output(
                `[{"id":"in-01","kind":"blocked","title":"Which release?","from":"les","claimer":"claude-abc"}]`,
              ),
            );
          case "handoff list --limit 20 --json":
            return Effect.succeed(
              output(`[
              {"id":"hof-abc123","state":"claimed","goal":"Run tests","claimer":"wrk-build-box"},
              {"id":"hof-abc456","state":"claimed","goal":"Check docs","claimer":"cloud","cloud_state":"running","cloud_usd":0.75}
            ]`),
            );
          case "handoff show hof-abc456 --json":
            return Effect.succeed(
              output(`{
              "id":"hof-abc456", "state":"done", "cloud_state":"failed",
              "created":"2026-11-20T09:00:00Z",
              "worker_branch":"agentd/hof-abc456",
              "body":{"goal":"Check docs","model_access":"byok","anthropic_key_file":"/private/model-key"},
              "cloud":{"state":"failed","worker_usd":0.75,"inference_usd":0,"total_usd":0.75,
                "result":"the GitHub App is not installed on owner/fork: the repository's owner installs it once for that repository"}
            }`),
            );
          case "handoff show hof-abc789 --json":
            return Effect.succeed(
              output(`{
              "id":"hof-abc789", "state":"claimed", "cloud_state":"running",
              "created":"2026-11-20T09:00:00Z",
              "history":[{"state":"claimed","note":"held for the cloud Job API","created":"2026-11-20T09:00:01Z"}],
              "body":{"goal":"On my plan","model_access":"subscription","codex_auth_file":"/private/auth.json"}
            }`),
            );
          case "handoff done hof-abc456 --cancel --reason Stopped from LibraOS Next":
            return Effect.succeed(output("{}"));
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      expect((yield* bridge.people({ includeNodes: true })).nodes).toEqual([
        {
          name: "build-box",
          host: "runner-2",
          person: "Les",
          state: "busy",
          why: "Building locally",
          seen: "2026-11-18T09:14:00Z",
          offline: false,
        },
      ]);
      expect(yield* bridge.approvals).toMatchObject([{ id: "ap-01", requester: "codex-abc" }]);
      expect(yield* bridge.inbox).toMatchObject([{ id: "in-01", requester: "claude-abc" }]);
      const first = yield* Stream.runHead(bridge.subscribeTasks);
      expect(first._tag === "Some" ? first.value : null).toMatchObject([
        { id: "hof-abc123", runsOn: "team", workerName: "build-box" },
        { id: "hof-abc456", runsOn: "cloud", cloudState: "running", cloudUsd: 0.75 },
      ]);
      const task = yield* bridge.task({ id: "hof-abc456" });
      expect(task).toMatchObject({
        runsOn: "cloud",
        started: "2026-11-20T09:00:00Z",
        branch: "agentd/hof-abc456",
        cloud: {
          state: "failed",
          modelAccess: "byok",
          plan: null,
          workerUsd: 0.75,
          inferenceUsd: 0,
          totalUsd: 0.75,
        },
        note: "The repository owner must install the Cloud Workers GitHub App on this repository.",
      });
      expect(JSON.stringify(task)).not.toContain("/private/model-key");
      const subscribed = yield* bridge.task({ id: "hof-abc789" });
      expect(subscribed.started).toBe("2026-11-20T09:00:00Z");
      expect(subscribed.cloud).toMatchObject({ modelAccess: "subscription", plan: "codex" });
      expect(JSON.stringify(subscribed)).not.toContain("/private/auth.json");
      expect(
        yield* bridge.stopTask({ id: "hof-abc456", reason: "Stopped from LibraOS Next" }),
      ).toEqual({});
    }),
  );

  it.effect("re-runs a stuck task's check as a fixed argument list and shows its last run", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      let code = 0;
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        if (input.args[1] === "show") {
          return Effect.succeed(
            output(`{
              "id":"hof-abc456","state":"claimed","worker_state":"gone","report_note":"Tests fail on main",
              "verdict":{"verdict":"act","next":"not finished (worker gone)"},
              "results":[{"check_result":"failed: exit 1"},{"check_result":"not run"}]
            }`),
          );
        }
        calls.push(input.args);
        return Effect.succeed({
          ...output(code === 0 ? `{"result":"passed"}` : ""),
          code: ChildProcessSpawner.ExitCode(code),
          stderr: code === 0 ? "" : "check failed (exit 1): vp test\n1 failed",
        });
      });
      expect(yield* bridge.recheckTask({ id: "hof-abc456" })).toEqual({});
      code = 1;
      const failure = yield* Effect.flip(bridge.recheckTask({ id: "hof-abc456" }));
      expect(failure).toMatchObject({
        _tag: "AgentdCommandError",
        message: "check failed (exit 1): vp test\n1 failed",
      });
      yield* Effect.flip(bridge.recheckTask({ id: "--session=x" }));
      expect(yield* bridge.task({ id: "hof-abc456" })).toMatchObject({
        report: "Tests fail on main",
        verdict: { check: "failed: exit 1", next: "not finished (worker gone)" },
      });
      expect(calls).toEqual([
        ["handoff", "recheck", "hof-abc456"],
        ["handoff", "recheck", "hof-abc456"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts an existing unassigned local task through the app session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const cwd = process.cwd();
      const queued = {
        id: "hof-0e3d000001",
        state: "offered",
        to_session: "any",
        origin: { dir: cwd },
        created: "2026-11-20T09:00:00+00:00",
      };
      let details: Record<string, unknown> = queued;
      const bridge = yield* makeBridge(
        { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
        (input) => {
          const line = input.args.join(" ");
          calls.push(line);
          switch (line) {
            case "handoff show hof-0e3d000001 --json":
              return Effect.succeed(output(JSON.stringify(details)));
            case "handoff list --limit 20 --json":
              return Effect.succeed(output("[]"));
            case `session join --id agentd-new --tool other --label agentd new --wake pull --cwd ${cwd}`:
            case `handoff dispatch hof-0e3d000001 --tool codex --cwd ${cwd} --session agentd-new`:
            case `handoff dispatch hof-0e3d000001 --tool codex --force --cwd ${cwd} --session agentd-new`:
              return Effect.succeed(output("{}"));
            default:
              return Effect.die(`unexpected agentd ${line}`);
          }
        },
      );
      const input = { id: queued.id, worker: "codex", action: "queued" } as const;
      details = { ...queued, state: "claimed", dispatched: "2026-11-24T09:00:00+00:00" };
      expect(yield* bridge.task({ id: queued.id })).toMatchObject({
        started: "2026-11-24T09:00:00+00:00",
        created: queued.created,
      });
      for (const state of ["cancelled", "blocked", "held"]) {
        details = { ...queued, state };
        expect(yield* bridge.task({ id: queued.id })).toMatchObject({
          started: null,
          created: queued.created,
        });
      }
      details = {
        ...queued,
        state: "claimed",
        history: [
          { state: "offered", created: queued.created },
          { state: "claimed", note: "", created: "2026-11-23T09:00:00+00:00" },
          { state: "claimed", note: "Reported progress", created: "2026-11-24T09:00:00+00:00" },
        ],
      };
      expect(yield* bridge.task({ id: queued.id })).toMatchObject({
        started: "2026-11-23T09:00:00+00:00",
      });
      const reofferedAt = "2026-11-24T09:00:00+00:00";
      details = {
        ...queued,
        history: [
          { state: "offered", created: queued.created },
          { state: "claimed", created: "2026-11-23T09:00:00+00:00", note: "" },
          {
            state: "offered",
            created: reofferedAt,
            note: "the watchdog will start its worker again",
          },
          {
            state: "offered",
            created: "2026-11-24T09:01:00+00:00",
            note: "not dispatched: folder busy",
          },
        ],
      };
      expect(yield* bridge.task({ id: queued.id })).toMatchObject({
        queuedSince: reofferedAt,
      });

      const parked = { ...queued, project: "libraos/next", parked: "4 worker rounds, the limit" };
      details = {
        ...parked,
        worker: "codex",
        worker_cwd: cwd,
        origin: null,
        a2a_state: "input-required",
      };
      expect(yield* bridge.task({ id: queued.id })).toMatchObject({
        parked: parked.parked,
        startFolder: cwd,
      });
      expect((yield* bridge.task({ id: queued.id })).queuePickup).toBeUndefined();
      const forceParked = { ...input, action: "parked" } as const;
      expect(yield* bridge.retryStart(forceParked)).toMatchObject({ started: true });
      expect(calls.at(-1)).toBe(
        `handoff dispatch hof-0e3d000001 --tool codex --force --cwd ${cwd} --session agentd-new`,
      );
      for (const changed of [
        { parked: null },
        { claimer: "codex-ab1234" },
        { to_user: "alice" },
        { required_labels: ["gpu=a100"] },
        { worker_cwd: `${cwd}/missing-queued-checkout` },
      ]) {
        details = { ...parked, ...changed };
        calls.length = 0;
        yield* Effect.flip(bridge.retryStart(forceParked));
        expect(calls).toEqual(["handoff show hof-0e3d000001 --json"]);
      }
      for (const [reason, parkAction, message] of [
        ["breaker: too many failed attempts", "unpark", /handoff unpark/],
        ["budget: worker spent its budget", "unpark", /handoff unpark/],
        ["undelivered: commit did not reach origin", "unpark", /handoff unpark/],
        ["diverged: branch diverged from origin", "unpark", /handoff unpark/],
        ["repository command: setup requires approval", "approval", /Engine Inbox/],
      ] as const) {
        details = { ...parked, parked: reason };
        calls.length = 0;
        const failure = yield* Effect.flip(bridge.retryStart(forceParked));
        expect(failure.message).toMatch(message);
        expect(calls).toEqual(["handoff show hof-0e3d000001 --json"]);
        expect(yield* bridge.task({ id: queued.id })).toMatchObject({ parked: reason, parkAction });
      }

      details = { ...queued, origin: { dir: "another-checkout" }, worker_cwd: cwd };
      expect(yield* bridge.retryStart(input)).toEqual({ id: queued.id, started: true, note: null });
      expect(calls.slice(-2)).toEqual([
        `session join --id agentd-new --tool other --label agentd new --wake pull --cwd ${cwd}`,
        `handoff dispatch hof-0e3d000001 --tool codex --cwd ${cwd} --session agentd-new`,
      ]);
      expect(
        yield* bridge.retryStart({
          id: queued.id,
          worker: "codex",
          action: "force",
          blocking: "hof-123abc",
          queued: true,
        }),
      ).toMatchObject({ started: true });
      expect(calls.at(-1)).toBe(
        `handoff dispatch hof-0e3d000001 --tool codex --force --cwd ${cwd} --session agentd-new`,
      );
      details = {
        ...queued,
        project: "libraos/next",
        check_cmd: "git status --short",
        queue_reason: "awaiting check approval",
      };
      expect(yield* bridge.retryStart(input)).toEqual({ id: queued.id, started: true, note: null });
      details = { ...queued, to_user: "work-account" };
      expect(yield* bridge.retryStart(input)).toMatchObject({ started: true });
      for (const queueReason of [
        "spec before code: missing spec",
        "project concurrency limit: libraos/next",
      ]) {
        details = { ...queued, project: "libraos/next", queue_reason: queueReason };
        expect(yield* bridge.task({ id: queued.id })).toMatchObject({ queueBlock: queueReason });
        expect(yield* Effect.flip(bridge.retryStart(input))).toMatchObject({
          message: queueReason,
        });
      }
      for (const [changed, pickup] of [
        [{ to_session: "codex-other" }, "recipient"],
        [{ to_user: "alice" }, "recipient"],
        [{ to_user: "work-account" }, undefined],
        [{ to_user: "work-account", required_labels: ["gpu=a100"] }, "remote"],
        [{ project: "libraos/next", queue_reason: "awaiting check approval" }, undefined],
        [{ project: "libraos/next", queue_reason: "spec before code: missing spec" }, undefined],
        [
          { project: "libraos/next", queue_reason: "project concurrency limit: libraos/next" },
          undefined,
        ],
        [{ project: "libraos/next", required_labels: ["gpu=a100"] }, "remote"],
        [{ project: "libraos/next", queue_reason: "awaiting eligible worker poll" }, "remote"],
        [{ project: "libraos/next" }, undefined],
        [{ project: "libraos/next", via_run: 1 }, undefined],
        [
          { project: "libraos/next", queue_reason: "no live worker serves project libraos/next" },
          undefined,
        ],
      ] as const) {
        details = { ...queued, ...changed };
        expect((yield* bridge.task({ id: queued.id })).queuePickup).toBe(pickup);
      }
      for (const workerField of ["worker", "worker_tool", "start_tool"]) {
        details = { ...queued, [workerField]: "claude" };
        expect((yield* bridge.task({ id: queued.id })).workerTool).toBe("claude");
      }
      for (const changed of [
        { state: "claimed" },
        { worker_running: true },
        { worker_state: "blocked" },
        { start_tool: "claude" },
        { parked: "Environment setup failed" },
        { worker: "codex" },
        { worker_tool: "codex" },
        { cloud_state: "queued" },
        { to_session: "codex-other" },
        { origin: null },
        { origin: { dir: "relative" } },
        { worker_cwd: `${cwd}/missing-queued-checkout` },
        { budget_state: "budget_exceeded" },
        { budget_state: "stopped" },
        { claimer: "codex-ab1234" },
        { project: "libraos/next", body: { labels: "gpu=a100" } },
        { project: "libraos/next", queue_reason: "awaiting eligible worker poll" },
      ]) {
        details = { ...queued, ...changed };
        calls.length = 0;
        const failure = yield* Effect.flip(bridge.retryStart({ ...input, worker: "claude" }));
        const refusal =
          "origin" in changed || "worker_cwd" in changed
            ? "no-checkout"
            : "to_session" in changed
              ? "has-recipient"
              : "no-longer-queued";
        expect(failure).toMatchObject({ queuedStartRefusal: refusal });
        expect(
          calls.every((call) => call.startsWith("handoff show") || call.startsWith("handoff list")),
        ).toBe(true);
      }
    }),
  );

  it.effect("includes older offers when the recent task page fills", () =>
    Effect.gen(function* () {
      const recent = Array.from({ length: 20 }, (_, index) => ({
        id: `hof-${index.toString(16).padStart(6, "0")}`,
        state: index === 0 ? "offered" : "done",
      }));
      const older = { id: "hof-abcdef", state: "offered" };
      const firstOffered = yield* Deferred.make<void>();
      let olderReads = 0;
      let recentReads = 0;
      const bridge = yield* makeBridge(
        { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
        (input) => {
          const key = input.args.join(" ");
          if (key === "handoff list --limit 20 --json") {
            const current = recentReads++ === 0 ? recent : recent.slice(1).concat(recent[0]!);
            return Effect.succeed(output(JSON.stringify(current)));
          }
          if (key === "handoff list --state offered --limit 20 --user work-account --json") {
            olderReads++;
            return Deferred.succeed(firstOffered, undefined).pipe(
              Effect.as(output(JSON.stringify([recent[0], older]))),
            );
          }
          return Deferred.succeed(firstOffered, undefined).pipe(
            Effect.andThen(Effect.die(`unexpected agentd ${key}`)),
          );
        },
      );
      const lists = yield* bridge.subscribeTasks.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstOffered);
      yield* TestClock.adjust("5 seconds");
      const [first, second] = yield* Fiber.join(lists);
      expect(first?.map((row) => row.id)).toEqual([...recent.map((row) => row.id), older.id]);
      expect(second?.at(-1)?.id).toBe(older.id);
      expect(olderReads).toBe(1);
    }),
  );

  it.effect("names the task holding the directory, and releases or forces past it as chosen", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let running = false;
      const refusal =
        "error: dispatch refused: /work/app already has handoff hof-b10c4ed001, claimed by session codex-615065aa16; wait for it, use another worktree or issue, or override with --force";
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const line = input.args.join(" ");
        calls.push(line);
        if (input.args[0] === "new") return Effect.succeed(output(`{"handoff":"hof-0e3d000001"}`));
        switch (line) {
          case "handoff dispatch hof-0e3d000001 --tool codex":
            return Effect.succeed(
              calls.includes(
                "handoff done hof-b10c4ed001 --cancel --reason Released from LibraOS Next to start hof-0e3d000001",
              )
                ? output("{}")
                : { ...output("", 1), stderr: refusal },
            );
          case "handoff dispatch hof-0e3d000001 --tool codex --force":
          case "handoff done hof-b10c4ed001 --cancel --reason Released from LibraOS Next to start hof-0e3d000001":
            return Effect.succeed(output("{}"));
          case "handoff list --limit 20 --json":
            return Effect.succeed(
              output(
                JSON.stringify([
                  {
                    id: "hof-b10c4ed001",
                    state: "claimed",
                    goal: "Tidy the README",
                    ...(running ? { worker_running: true } : {}),
                  },
                ]),
              ),
            );
          default:
            return Effect.die(`unexpected agentd ${line}`);
        }
      });
      const started = yield* bridge.startTask({
        goal: "Fix the login form",
        accept: [],
        check: null,
        worker: "codex",
        budget: "30m",
        cwd: "/work/app",
        issue: null,
      });
      expect(started).toEqual({
        id: "hof-0e3d000001",
        started: false,
        note: refusal,
        blocking: {
          id: "hof-b10c4ed001",
          state: "claimed",
          goal: "Tidy the README",
          running: false,
        },
      });

      const retry = { id: "hof-0e3d000001", worker: "codex", blocking: "hof-b10c4ed001" } as const;
      running = true;
      const live = yield* Effect.flip(bridge.retryStart({ ...retry, action: "release" }));
      expect(live.message).toBe(
        "Task hof-b10c4ed001 still has a worker running, so it was not released.",
      );
      expect(calls.some((call) => call.startsWith("handoff done"))).toBe(false);

      calls.length = 0;
      expect(yield* bridge.retryStart({ ...retry, action: "force" })).toMatchObject({
        started: true,
      });
      expect(calls).toEqual(["handoff dispatch hof-0e3d000001 --tool codex --force"]);

      running = false;
      calls.length = 0;
      expect(yield* bridge.retryStart({ ...retry, action: "release" })).toMatchObject({
        started: true,
      });
      expect(calls).toEqual([
        "handoff list --limit 20 --json",
        "handoff done hof-b10c4ed001 --cancel --reason Released from LibraOS Next to start hof-0e3d000001",
        "handoff dispatch hof-0e3d000001 --tool codex",
      ]);
    }),
  );

  it.effect("syncs open cloud jobs beside the task list, never holding it up", () =>
    Effect.gen(function* () {
      const row = (state: string) =>
        JSON.stringify([
          { id: "hof-c10d000001", goal: "Fix it", state: "claimed", cloud_state: state },
        ]);
      let listed = row("queued");
      const syncStarted = yield* Deferred.make<void>();
      const firstListed = yield* Deferred.make<void>();
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const key = input.args.join(" ");
        if (key === "handoff list --limit 20 --json") {
          const answer = listed;
          listed = row("running");
          return Deferred.succeed(firstListed, undefined).pipe(Effect.as(output(answer)));
        }
        // A Job API that never answers.
        if (key === "cloud sync")
          return Deferred.succeed(syncStarted, undefined).pipe(Effect.andThen(Effect.never));
        return Effect.die(`unexpected agentd ${key}`);
      });
      yield* TestClock.setTime(31_000);
      const lists = yield* bridge.subscribeTasks.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstListed);
      yield* TestClock.adjust("5 seconds");
      const [first, second] = yield* Fiber.join(lists);
      yield* Deferred.await(syncStarted);
      expect(first?.[0]?.cloudState).toBe("queued");
      expect(second?.[0]?.cloudState).toBe("running");
    }),
  );

  it.effect("repairs services only as confirmed, and says so only once they run this agentd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const units = path.join(home, ".config", "systemd", "user");
      yield* fs.makeDirectory(units, { recursive: true });
      const unit = path.join(units, "agentd-watchdog.service");
      yield* fs.writeFileString(unit, "[Service]\nExecStart=/gone/agentd watchdog\n");
      let rewrites = false;
      // Whether install gets as far as the timer: it writes the service first, stops at an error.
      let writesTimer = false;
      // Whether systemd can start the timer; enabling it links it into timers.target either way.
      let starts = false;
      let active = false;
      const runs: Array<string> = [];
      const bridge = yield* makeBridge(
        { PATH: "", AGENTD_BIN: process.execPath, AGENTD_DESKTOP_BUNDLED: "1" },
        (input) => {
          runs.push([input.command, ...input.args].join(" "));
          if (input.command === "systemctl") {
            if (input.args[1] === "is-active")
              return Effect.succeed(active ? output("active\n") : output("inactive\n", 3));
            if (input.args[1] !== "enable") return Effect.succeed(output(""));
            const timer = path.join(units, "agentd-watchdog.timer");
            const wants = path.join(units, "timers.target.wants");
            // systemd links only a timer that is written.
            const link = fs.makeDirectory(wants, { recursive: true }).pipe(
              Effect.andThen(
                fs
                  .symlink(
                    path.join(units, "agentd-watchdog.timer"),
                    path.join(wants, "agentd-watchdog.timer"),
                  )
                  .pipe(Effect.ignore),
              ),
              Effect.orDie,
              Effect.andThen(
                Effect.sync(() => {
                  active = starts;
                  return output("", starts ? 0 : 1);
                }),
              ),
            );
            return fs.exists(timer).pipe(
              Effect.orDie,
              Effect.flatMap((written) => (written ? link : Effect.succeed(output("", 1)))),
            );
          }
          if (input.args[0] !== "install") return Effect.succeed(output(""));
          if (!rewrites)
            return Effect.succeed(
              output("then: systemctl --user enable --now agentd-watchdog.timer\n"),
            );
          const service = fs.writeFileString(
            unit,
            `[Service]\nExecStart=${process.execPath} watchdog\n`,
          );
          if (!writesTimer) return service.pipe(Effect.orDie, Effect.as(output("", 1)));
          return service.pipe(
            Effect.andThen(
              fs.writeFileString(path.join(units, "agentd-watchdog.timer"), "[Timer]\n"),
            ),
            Effect.orDie,
            Effect.as(output("then: systemctl --user enable --now agentd-watchdog.timer\n")),
          );
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      // A scope other than the one confirmed now: refused, nothing run.
      expect(
        yield* Effect.flip(bridge.repairServices({ moves: ["watchdog", "dash"] })),
      ).toMatchObject({ _tag: "AgentdCommandError" });
      expect(runs.filter((run) => run.includes("install"))).toEqual([]);
      // An install that leaves the stale program in effect is no repair.
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      rewrites = true;
      // Install rewrites the service, then fails before the timer: a failure, and the next Repair
      // runs install again.
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      runs.length = 0;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      expect(runs).toContain(`${process.execPath} install`);
      writesTimer = true;
      // The unit is rewritten, systemd enables its timer but can't start it: still a failure, and
      // the same Repair is still offered.
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      // Once systemd can start it, the same Repair starts the timer, and then has nothing to do.
      starts = true;
      runs.length = 0;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: true });
      expect(runs).toContain("systemctl --user enable --now agentd-watchdog.timer");
      runs.length = 0;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: true });
      expect(runs.filter((run) => !run.startsWith("systemctl --user show"))).toEqual([
        "systemctl --user is-active agentd-watchdog.timer",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Repair while systemd still runs the stale service a failed reload kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const units = path.join(home, ".config", "systemd", "user");
      const wants = path.join(units, "timers.target.wants");
      yield* fs.makeDirectory(wants, { recursive: true });
      const unit = path.join(units, "agentd-watchdog.service");
      yield* fs.writeFileString(unit, "[Service]\nExecStart=/gone/agentd watchdog\n");
      yield* fs.writeFileString(path.join(units, "agentd-watchdog.timer"), "[Timer]\n");
      yield* fs.symlink(
        path.join(units, "agentd-watchdog.timer"),
        path.join(wants, "agentd-watchdog.timer"),
      );
      // The timer is on throughout; what it starts is the service systemd last loaded.
      let loaded = "/gone/agentd";
      let reloads = false;
      const runs: Array<string> = [];
      const bridge = yield* makeBridge(
        { PATH: "", AGENTD_BIN: process.execPath, AGENTD_DESKTOP_BUNDLED: "1" },
        (input) => {
          runs.push([input.command, ...input.args].join(" "));
          if (input.command === "systemctl") {
            switch (input.args[1]) {
              case "is-active":
                return Effect.succeed(output("active\n"));
              case "show":
                return fs.readFileString(unit).pipe(
                  Effect.orDie,
                  Effect.map((text) =>
                    output(
                      `NeedDaemonReload=${text.includes(loaded) ? "no" : "yes"}\n` +
                        `ExecStart={ path=${loaded} ; argv[]=${loaded} watchdog ; ignore_errors=no }\n`,
                    ),
                  ),
                );
              case "daemon-reload":
                if (!reloads) return Effect.succeed(output("", 1));
                loaded = process.execPath;
                return Effect.succeed(output(""));
              default:
                return Effect.succeed(output(""));
            }
          }
          if (input.args[0] !== "install") return Effect.succeed(output(""));
          return fs
            .writeFileString(unit, `[Service]\nExecStart=${process.execPath} watchdog\n`)
            .pipe(
              Effect.orDie,
              Effect.as(output("then: systemctl --user enable --now agentd-watchdog.timer\n")),
            );
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      // The file is rewritten but the reload fails: the timer still runs the gone agentd.
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      runs.length = 0;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: false });
      expect(runs).toContain("systemctl --user daemon-reload");
      // Once systemd reloads, the same Repair succeeds, and then has nothing to do.
      reloads = true;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: true });
      runs.length = 0;
      expect(yield* bridge.repairServices({ moves: ["watchdog"] })).toEqual({ ok: true });
      expect(runs.some((run) => run.includes("install"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a shown services problem again on each status read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const units = path.join(home, ".config", "systemd", "user");
      yield* fs.makeDirectory(units, { recursive: true });
      const unit = path.join(units, "agentd-dash.service");
      yield* fs.writeFileString(unit, "[Service]\nExecStart=/gone/agentd dash\n");
      const bridge = yield* makeBridge(
        { PATH: "", AGENTD_BIN: process.execPath, AGENTD_DESKTOP_BUNDLED: "1" },
        (input) => {
          const key = input.args.join(" ");
          if (key === "version") return Effect.succeed(output("agentd v0.1.15\n"));
          if (key === "doctor --json") return Effect.succeed(output(DOCTOR_JSON, 1));
          return Effect.succeed(output(""));
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      // A Repair of another scope only reads the services: the stale dash is now known.
      yield* Effect.flip(bridge.repairServices({ moves: ["watchdog"] }));
      expect((yield* bridge.status).servicesProblem).toMatchObject({ moves: ["dash"] });
      // Fixed by hand, as the notice says: the next read no longer shows it.
      yield* fs.writeFileString(unit, `[Service]\nExecStart=${process.execPath} dash\n`);
      expect(yield* bridge.status).not.toHaveProperty("servicesProblem");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers every method with AgentdNotFoundError when there is no agentd", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ PATH: "" }, () => Effect.die("agentd must not run"));
      const id = "hof-a6e5f4e329";
      const failures = yield* Effect.forEach(
        [
          bridge.status,
          Stream.runHead(bridge.subscribeTasks),
          bridge.task({ id }),
          Stream.runHead(bridge.subscribeTaskOutput({ id })),
          bridge.stopTask({ id, reason: "not needed" }),
          bridge.startTask({
            goal: "Fix it",
            accept: [],
            check: null,
            worker: "codex",
            budget: "30m",
            cwd: "/repo",
            issue: null,
          }),
          bridge.approvals,
          bridge.inbox,
          bridge.people({}),
          bridge.connectAgent({ agent: "opencode", dryRun: true }),
          bridge.joinTeam({ server: "https://agentd.example", ticket: "adt_0123456789abcdefXYZ" }),
        ],
        (effect) => Effect.flip(effect),
      );
      expect(failures.map((error) => error._tag)).toEqual(
        Array.from({ length: 11 }, () => "AgentdNotFoundError"),
      );
      expect(failures[0]).not.toHaveProperty("bundled");
      const bundled = yield* makeBridge(
        { PATH: "", AGENTD_BIN: "/missing/agentd", AGENTD_DESKTOP_BUNDLED: "1" },
        () => Effect.die("agentd must not run"),
      );
      expect(yield* Effect.flip(bundled.status)).toMatchObject({
        _tag: "AgentdNotFoundError",
        bundled: true,
      });
    }),
  );

  it.effect("runs libraos-engine from PATH, else libraos-core, else agentd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Each case gets its own PATH: command lookups are cached per PATH.
      const ranWith = Effect.fn(function* (installed: { early: string[]; late: string[] }) {
        const root = yield* fs.makeTempDirectoryScoped();
        for (const [dir, names] of Object.entries(installed)) {
          yield* fs.makeDirectory(path.join(root, dir));
          for (const name of names) {
            yield* fs.writeFileString(path.join(root, dir, name), "#!/bin/sh\n");
            yield* fs.chmod(path.join(root, dir, name), 0o755);
          }
        }
        const commands: string[] = [];
        const bridge = yield* makeBridge(
          { PATH: `${path.join(root, "early")}:${path.join(root, "late")}` },
          (input) => {
            commands.push(input.command);
            return Effect.succeed(output("[]"));
          },
        );
        yield* Effect.exit(bridge.inbox);
        return path.relative(root, commands[0]!);
      });

      expect(yield* ranWith({ early: ["agentd"], late: [] })).toBe(path.join("early", "agentd"));
      expect(yield* ranWith({ early: ["agentd"], late: ["libraos-core"] })).toBe(
        path.join("late", "libraos-core"),
      );
      expect(yield* ranWith({ early: ["agentd", "libraos-core"], late: ["libraos-engine"] })).toBe(
        path.join("late", "libraos-engine"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("asks before a Claude worker runs where Claude Code was never trusted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const repo = path.join(home, "app");
      const worktree = path.join(home, "app-wt");
      const ran: string[] = [];
      const bridge = yield* makeBridge({ PATH: "", AGENTD_BIN: process.execPath }, (input) => {
        if (input.command === "git") return Effect.succeed(output(`${path.join(repo, ".git")}\n`));
        ran.push(input.args[0]!);
        return Effect.succeed(
          output(input.args[0] === "new" ? '{"handoff":"hof-a6e5f4e329"}' : "{}"),
        );
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      const input = {
        goal: "Fix it",
        accept: [],
        check: null,
        worker: "claude",
        budget: "30m",
        cwd: worktree,
        issue: null,
      } as const;

      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ untrustedFolder: repo });
      expect(ran).toEqual([]);
      // Another worker is not Claude Code's to trust.
      yield* bridge.startTask({ ...input, worker: "codex" });
      expect(ran).toEqual(["new", "handoff"]);

      expect(yield* bridge.startTask({ ...input, trustClaudeFolder: true })).toMatchObject({
        started: true,
      });
      expect(JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")))).toEqual({
        projects: { [repo.replace(/\\/g, "/")]: { hasTrustDialogAccepted: true } },
      });
      // Trusted now: no question the next time.
      yield* bridge.startTask(input);
      expect(ran).toEqual(["new", "handoff", "new", "handoff", "new", "handoff"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("offers cloud jobs against origin and passes only absolute key file paths", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      let origin = "git@github.com:fork-owner/its-fork.git";
      let version = "agentd v0.1.13";
      let help = "usage: agentd handoff offer [--cloud]";
      let receipt = '{"handoff":"hof-abc123","cloud":{"state":"queued"}}';
      let balance = output('{"available_usd":"12.75","default_budget":"30m,$5"}');
      const ledger = cloudLedger();
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        if (input.args.includes("--cloud")) {
          const parsed = JSON.parse(receipt) as { handoff: string; cloud: { state: string } };
          ledger.record(input.args, parsed.handoff, parsed.cloud.state);
        }
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output(version));
          case "remote get-url":
            return Effect.succeed(output(origin));
          case "cloud balance":
            return Effect.succeed(balance);
          case "help cloud":
            return Effect.succeed(output("usage: agentd cloud sync | balance"));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            return Effect.succeed(output(input.args.includes("--help") ? help : receipt));
          default:
            return Effect.die("unexpected command");
        }
      });

      const platform = yield* HostProcess.Platform;
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const cwd = platform === "win32" ? "C:\\work\\fork" : "/work/fork";
      const keyFile = path.join(cwd, "private", "OpenAI key.txt");
      const input = { cwd, goal: "Fix the check", accept: ["Pass it"], check: "pnpm test" };
      // A probe agentd answers with nothing is no answer: the option stays, with Retry.
      help = "";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        supported: true,
        unreachable: true,
      });
      help = "usage: agentd handoff offer [--cloud]";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toEqual({
        supported: true,
        canConfigure: false,
        setupUrl: null,
        subscription: null,
        project: "fork-owner/its-fork",
        balanceUsd: 12.75,
        balanceText: null,
        plan: null,
        defaultBudget: "30m,$5",
        problem: null,
      });
      balance = output(
        JSON.stringify({
          available_usd: "8.50",
          held_usd: "1.00",
          plan: {
            name: "Team",
            worker_minutes_included: 3600,
            worker_minutes_used: "1800",
            worker_minutes_reserved: 200,
            worker_minutes_left: 1600,
            month_ends_at: "2026-12-01T00:00:00Z",
          },
        }),
      );
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        balanceUsd: 8.5,
        plan: {
          name: "Team",
          includedMinutes: 3600,
          usedMinutes: 1800,
          reservedMinutes: 200,
          leftMinutes: 1600,
          monthEndsAt: "2026-12-01T00:00:00Z",
        },
      });
      // A malformed plan keeps the credit and drops only what can't be read.
      balance = output(
        '{"available_usd":2,"plan":{"worker_minutes_included":"lots","worker_minutes_used":-5,"month_ends_at":"soon"}}',
      );
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        balanceUsd: 2,
        plan: {
          name: null,
          includedMinutes: null,
          usedMinutes: null,
          reservedMinutes: null,
          leftMinutes: null,
          monthEndsAt: null,
        },
      });
      balance = output('{"available_usd":2,"plan":"pro"}');
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        balanceUsd: 2,
        plan: null,
      });
      balance = output('{"available_usd":"12.75","default_budget":"30m,$5"}');
      expect(
        yield* bridge.startTask({ ...input, cloud: { modelAccess: "libraos", budget: "$5" } }),
      ).toEqual({ id: "hof-abc123", started: true, note: null });
      const byok = { modelAccess: "byok", budget: "20m,$8", openaiKeyFile: keyFile } as const;
      yield* bridge.startTask({ ...input, check: null, cloud: byok });
      const offers = () =>
        runs.filter(({ args }) => args.includes("--cloud")).map(({ args, stdin }) => [args, stdin]);
      expect(offers()).toEqual([
        [
          [
            "handoff",
            "offer",
            "--cloud",
            "--idem",
            expect.stringMatching(SUBMISSION),
            "--state",
            expect.stringMatching(MARKER),
            "--to",
            "any",
            "--session",
            "agentd-new",
            "--budget",
            "$5",
            "--model-access",
            "libraos",
            "--project",
            "fork-owner/its-fork",
            "--goal",
            "Fix the check",
            "--accept",
            "Pass it",
            "--check",
            "pnpm test",
            "--json",
          ],
          undefined,
        ],
        [
          [
            "handoff",
            "offer",
            "--cloud",
            "--idem",
            expect.stringMatching(SUBMISSION),
            "--state",
            expect.stringMatching(MARKER),
            "--to",
            "any",
            "--session",
            "agentd-new",
            "--budget",
            "20m,$8",
            "--model-access",
            "byok",
            "--openai-key-file",
            keyFile,
            "--project",
            "fork-owner/its-fork",
            "--goal",
            "Fix the check",
            "--accept",
            "Pass it",
            "--no-check",
            "--json",
          ],
          undefined,
        ],
      ]);
      // The unanswered probe is asked again; an answer is kept.
      expect(runs.filter(({ args }) => args.includes("--help"))).toHaveLength(2);
      expect(
        runs.filter(({ args }) => args[0] === "remote").map((run) => [run.args, run.cwd]),
      ).toEqual(Array.from({ length: 6 }, () => [["remote", "get-url", "--", "origin"], cwd]));

      const pastedKey = "sk-example-credential";
      yield* Effect.flip(
        bridge.startTask({ ...input, cloud: { ...byok, openaiKeyFile: pastedKey } }),
      );
      yield* Effect.flip(bridge.startTask({ ...input, cloud: { ...byok, budget: "20m" } }));
      expect(JSON.stringify(runs)).not.toContain(pastedKey);
      // A key file in the other provider's field is refused here, for callers that can't check it.
      const keys = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const anthropic = path.join(dir, "anthropic.key");
        const openai = path.join(dir, "openai.key");
        yield* fs.writeFileString(anthropic, "sk-ant-api03-example\n");
        yield* fs.writeFileString(openai, "  sk-proj-example\n");
        return { anthropic, openai };
      }).pipe(Effect.provide(NodeServices.layer));
      const before = offers().length;
      expect(
        yield* Effect.flip(
          bridge.startTask({ ...input, cloud: { ...byok, openaiKeyFile: keys.anthropic } }),
        ),
      ).toMatchObject({
        message:
          "The file in the OpenAI key field holds an Anthropic key, so nothing was submitted. Put each key file in its own provider’s field.",
        wrongKeyFile: "openai",
      });
      expect(
        (yield* Effect.flip(
          bridge.startTask({
            ...input,
            cloud: { modelAccess: "byok", budget: "20m,$8", anthropicKeyFile: keys.openai },
          }),
        )).message,
      ).toContain("Anthropic key field holds an OpenAI key");
      expect(offers()).toHaveLength(before);

      receipt =
        '{"handoff":"hof-abc123","cloud":{"state":"submitting","error":"402: insufficient credit"}}';
      expect(yield* bridge.startTask({ ...input, cloud: byok })).toEqual({
        id: "hof-abc123",
        started: false,
        note: "There is not enough LibraOS credit for this dollar cap.",
      });
      origin = "https://git.example.net/fork-owner/its-fork.git";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: false })).toMatchObject({
        supported: true,
        project: null,
      });
      yield* Effect.flip(bridge.startTask({ ...input, cloud: byok }));
      expect(offers()).toHaveLength(3);

      origin = "ssh://git@ssh.github.com:443/fork-owner/its-fork.git";
      balance = output("LibraOS balance: $12.75\n");
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        project: "fork-owner/its-fork",
        balanceUsd: null,
        balanceText: "LibraOS balance: $12.75",
      });
      balance = output("set [cloud] url and the account key in key_file", 1);
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        problem: "setup",
        balanceText: null,
      });

      version = "agentd v0.1.0";
      help = "usage: agentd handoff offer [--goal G]";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: false })).toMatchObject({
        supported: false,
      });
      expect(runs.filter(({ args }) => args.includes("--help"))).toHaveLength(3);
    }),
  );

  it.effect("checks agentd before retrying a cloud Start whose outcome is unknown", () =>
    Effect.gen(function* () {
      const runs: Array<ReadonlyArray<string>> = [];
      const ledger = cloudLedger();
      let offer: (args: ReadonlyArray<string>) => ProcessRunner.ProcessRunOutput = () =>
        output("killed", 137);
      let origin = "https://github.com/acme/app.git";
      let failPinAdd = false;
      let brokenPins = false;
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input.args);
        if (brokenPins && input.args[0] === "pin") return Effect.succeed(output("<html>"));
        const handoffPin = input.args[1] === "add" && input.args[2]?.includes('"handoff"');
        if (failPinAdd && input.args[0] === "pin" && handoffPin)
          return Effect.succeed(output("ledger busy", 1));
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.14"));
          case "remote get-url":
            return Effect.succeed(output(origin));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            return Effect.succeed(
              input.args.includes("--help")
                ? output("usage: agentd handoff offer [--cloud]")
                : offer(input.args),
            );
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const cwd = platform === "win32" ? "C:\\work\\app" : "/work/app";
      const clone = platform === "win32" ? "D:\\other\\app" : "/other/app";
      const input = {
        cwd,
        goal: "Fix the check",
        accept: [],
        check: "pnpm test",
        cloud: { modelAccess: "libraos", budget: "$5" },
      } as const;
      const offers = () => runs.filter((args) => args.includes("--cloud"));
      const keys = () => offers().map((args) => args[args.indexOf("--idem") + 1]);

      // Killed with nothing recorded: unknown, and a retry of the same draft reuses the paid key.
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      expect(keys()).toHaveLength(2);
      expect(new Set(keys()).size).toBe(1);

      // A different draft is refused while that reservation has no task, until the user replaces it.
      const other = { ...input, goal: "Update the changelog" };
      const refused = yield* Effect.flip(bridge.startTask(other));
      expect(refused).toMatchObject({ replaceSubmission: keys()[0] });
      expect(refused.message).toBe(
        "LibraOS Engine hasn’t confirmed your last cloud submission for this project, and it may still start. Replace it with this one? If it started, this one isn’t sent.",
      );
      expect(offers()).toHaveLength(2);

      // The first offer's task shows up only after the last lookup, and wins the shared key: the
      // replacement is not this draft's start, whether agentd answers with that task or refuses.
      const replace = { ...other, cloud: { ...other.cloud, replaceSubmission: keys()[0]! } };
      failPinAdd = true;
      for (const answer of [
        output('{"handoff":"hof-aabbcc","cloud":{"state":"queued"}}'),
        output("idempotency key reused with different request", 1),
      ]) {
        offer = () => {
          ledger.record(offers()[0]!, "hof-aabbcc", "queued");
          return answer;
        };
        expect(yield* bridge.startTask(replace)).toMatchObject({
          id: "hof-aabbcc",
          started: false,
          earlier: true,
        });
        ledger.handoffs.delete("hof-aabbcc");
      }
      expect(offers()).toHaveLength(4);
      failPinAdd = false;

      // agentd recorded the offer but the answer was lost, and so was the record of its task.
      offer = (args) => {
        ledger.record(args, "hof-aabbcc", "queued");
        return output("connection reset", 1);
      };
      failPinAdd = true;
      expect(
        yield* bridge.startTask({
          ...other,
          cloud: { ...other.cloud, replaceSubmission: keys()[0]! },
        }),
      ).toMatchObject({ id: "hof-aabbcc", started: false });
      expect(new Set(keys()).size).toBe(1);
      // The same draft again finds its own task; a different draft from another checkout of the
      // same project finds it as the earlier submission. Neither offers anything.
      const again = yield* bridge.startTask(other);
      expect(again).toMatchObject({ id: "hof-aabbcc", started: false });
      expect(again).not.toHaveProperty("earlier");
      failPinAdd = false;
      origin = "git@github.com:acme/app.git";
      expect(yield* bridge.startTask({ ...input, cwd: clone })).toMatchObject({
        id: "hof-aabbcc",
        started: false,
        earlier: true,
        note: expect.stringContaining("hof-aabbcc"),
      });
      expect(offers()).toHaveLength(5);

      // A task agentd is still submitting holds the project: no offer from any checkout.
      ledger.handoffs.set("hof-aabbcc", {
        ...ledger.handoffs.get("hof-aabbcc"),
        cloud_state: "submitting",
      });
      const held = yield* Effect.flip(bridge.startTask(other));
      expect(held.message).toBe(
        "Task hof-aabbcc for acme/app is still being submitted to Cloud Workers. Wait for it, or stop it in Background tasks, before starting another.",
      );
      expect(offers()).toHaveLength(5);

      // Once it is queued, a new Start is a new submission with a new key.
      ledger.handoffs.set("hof-aabbcc", {
        ...ledger.handoffs.get("hof-aabbcc"),
        cloud_state: "queued",
      });
      offer = (args) => {
        ledger.record(args, "hof-ddeeff", "queued");
        return output('{"handoff":"hof-ddeeff","cloud":{"state":"queued"}}');
      };
      expect(yield* bridge.startTask(other)).toEqual({
        id: "hof-ddeeff",
        started: true,
        note: null,
      });
      expect(new Set(keys()).size).toBe(2);

      // A reservation agentd cannot list is an unknown outcome, never a blind offer.
      brokenPins = true;
      expect(yield* Effect.flip(bridge.startTask(other))).toMatchObject({ outcomeUnknown: true });
      expect(offers()).toHaveLength(6);
    }),
  );

  it.effect("runs cloud tasks on the chosen Claude or ChatGPT plan's own file, or none", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      let help =
        "usage: agentd handoff offer [--cloud] [--model-access libraos|byok|subscription] [--claude-token-file F] [--codex-auth-file F]";
      // Recorded shape of `agentd cloud subscription --json`, trimmed.
      let report = output(
        '{"providers":{"claude":{"provider":"claude","configured":true,"file":"/home/me/.secrets/claude-token","valid":true,"expires_about":"2027-11-01"},"codex":{"provider":"codex","configured":false,"valid":false}},"default_provider":"claude","model_access":"subscription"}',
      );
      let claudeFile = output('"/home/me/.secrets/claude-token"');
      let codexFile = output('""');
      const ledger = cloudLedger();
      let handoff = 0;
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 3).join(" ")) {
          case "cloud subscription --json":
            return Effect.succeed(report);
          case "config get cloud.claude_token_file":
            return Effect.succeed(claudeFile);
          case "config get cloud.claude_token_expires_about":
            return Effect.succeed(output('"2027-10-02"'));
          case "config get cloud.codex_auth_file":
            return Effect.succeed(codexFile);
        }
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            // agentd's help is read once per version.
            return Effect.succeed(
              output(
                help.includes("codex")
                  ? "agentd v0.1.16"
                  : help.includes("claude")
                    ? "agentd v0.1.14"
                    : "agentd v0.1.13",
              ),
            );
          case "help cloud":
            return Effect.succeed(output("usage: agentd cloud sync | balance"));
          case "remote get-url":
            return Effect.succeed(output("git@github.com:acme/app.git"));
          case "cloud balance":
            return Effect.succeed(output('{"available_usd":"4.00"}'));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer": {
            if (input.args.includes("--help")) return Effect.succeed(output(help));
            const id = `hof-abc12${handoff++}`;
            ledger.record(input.args, id, "queued");
            return Effect.succeed(output(`{"handoff":"${id}","cloud":{"state":"queued"}}`));
          }
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const cwd = platform === "win32" ? "C:\\work\\app" : "/work/app";
      const authFile = path.join(cwd, "private", "auth.json");
      const task = (goal: string, cloud: Record<string, string>) =>
        bridge.startTask({
          cwd,
          goal,
          accept: [],
          check: null,
          cloud: { budget: "$3", modelAccess: "subscription", ...cloud },
        });
      const credentialFlags = () =>
        runs
          .filter(({ args }) => args.includes("--cloud"))
          .map(({ args }) =>
            args.filter(
              (arg, i) =>
                /^--(?:model-access|claude-token-file|codex-auth-file)$/.test(args[i - 1] ?? "") ||
                /^--(?:model-access|claude-token-file|codex-auth-file)$/.test(arg),
            ),
          );

      expect((yield* bridge.cloudSetup({ cwd, includeBalance: true })).subscription).toEqual({
        claude: { supported: true, configured: true, valid: true, expiresAbout: "2027-11-01" },
        codex: { supported: true, configured: false, valid: null, expiresAbout: null },
        setupUnavailable: platform === "win32",
      });
      // With no flag agentd runs on whichever plan is set up, so the chosen plan's file is named.
      yield* task("On the configured Claude token", { plan: "claude" });
      yield* task("On a chosen Claude token", { plan: "claude", claudeTokenFile: authFile });
      yield* task("On a chosen ChatGPT login", { plan: "codex", codexAuthFile: authFile });
      // Only Claude is set up: ChatGPT is refused before anything is submitted, never run on Claude.
      expect((yield* Effect.flip(task("ChatGPT, not set up", { plan: "codex" }))).message).toBe(
        "Your ChatGPT plan isn’t set up for Codex. Run codex login in a terminal.",
      );
      codexFile = output('"/home/me/.codex/auth.json"');
      yield* task("On the configured ChatGPT login", { plan: "codex" });
      claudeFile = output('""');
      expect((yield* Effect.flip(task("Claude, not set up", { plan: "claude" }))).message).toBe(
        "Your Claude subscription isn’t set up. Run claude setup-token in a terminal and save the token in a private file.",
      );
      claudeFile = output("config is locked", 1);
      expect((yield* Effect.flip(task("Claude, unreadable", { plan: "claude" }))).message).toBe(
        "LibraOS Engine couldn’t read which Claude token is set up, so nothing was submitted. Try again.",
      );
      claudeFile = output('"/home/me/.secrets/claude-token"');
      expect(credentialFlags()).toEqual([
        ["--model-access", "subscription", "--claude-token-file", "/home/me/.secrets/claude-token"],
        ["--model-access", "subscription", "--claude-token-file", authFile],
        ["--model-access", "subscription", "--codex-auth-file", authFile],
        ["--model-access", "subscription", "--codex-auth-file", "/home/me/.codex/auth.json"],
      ]);
      expect((yield* Effect.flip(task("No plan", {}))).message).toBe(
        "Choose the plan this cloud task runs on.",
      );
      // An expiry already past is not valid, whatever else agentd says.
      yield* TestClock.setTime(Date.parse("2027-11-02T00:00:00Z"));
      expect(
        (yield* bridge.cloudSetup({ cwd, includeBalance: true })).subscription?.claude,
      ).toEqual({ supported: true, configured: true, valid: false, expiresAbout: "2027-11-01" });
      yield* TestClock.setTime(0);

      // v0.1.14: Claude only; the token state comes from agentd's config keys. Its expiry dates any
      // nonempty file, so whether the token is valid is not known until a task runs.
      help = "usage: agentd handoff offer [--cloud] [--claude-token-file F]";
      report = output("unknown cloud command", 2);
      expect((yield* bridge.cloudSetup({ cwd, includeBalance: true })).subscription).toEqual({
        claude: { supported: true, configured: true, valid: null, expiresAbout: "2027-10-02" },
        codex: { supported: false, configured: false, valid: null, expiresAbout: null },
        setupUnavailable: platform === "win32",
      });
      yield* task("v0.1.14, on the configured Claude token", { plan: "claude" });
      expect((yield* Effect.flip(task("Too old", { plan: "codex" }))).message).toBe(
        "This version of LibraOS Engine can’t run Codex on your ChatGPT plan. Run libraos-core upgrade, then try again.",
      );
      help = "usage: agentd handoff offer [--cloud]";
      expect((yield* bridge.cloudSetup({ cwd, includeBalance: true })).subscription).toBeNull();
      expect((yield* Effect.flip(task("Older", { plan: "claude" }))).message).toBe(
        "This version of LibraOS Engine can’t run Cloud Workers on your own subscription. Run libraos-core upgrade, then try again.",
      );
      expect(credentialFlags()).toHaveLength(5);
      expect(credentialFlags()[4]).toEqual([
        "--model-access",
        "subscription",
        "--claude-token-file",
        "/home/me/.secrets/claude-token",
      ]);
      expect(runs.some(({ args }) => args.join(" ") === "cloud subscription --json")).toBe(true);
    }),
  );

  it.effect("installs the cloud account key from stdin only, to the Job API shown", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const key = "lcw_live_0123456789abcdefghij";
      const libraos = "https://cloud-api.libraos.com";
      let target = output(`{"url":"${libraos}","dry_run":true}`);
      let cloudHelp = "usage: agentd cloud sync | balance";
      let setup = output(
        '{"url":"https://cloud-api.libraos.com","balance":{"available_usd":12.5}}',
      );
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.15"));
          case "help cloud":
            return Effect.succeed(output(cloudHelp));
          case "handoff offer":
            return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
          case "cloud setup":
            return Effect.succeed(setup);
          case "cloud balance":
            return Effect.succeed(
              output(
                "a cloud handoff needs [cloud] url for the Job API. Run agentd cloud setup",
                1,
              ),
            );
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const setups = () => runs.filter(({ args }) => args[1] === "setup");

      // Before v0.1.15 there is nothing to run: the app keeps the Console link.
      expect(yield* bridge.cloudSetup({ cwd: null, includeBalance: true })).toMatchObject({
        supported: true,
        canConfigure: false,
        project: null,
        problem: "setup",
      });
      expect((yield* Effect.flip(bridge.cloudConfigure({ key, url: libraos }))).message).toBe(
        "This version of LibraOS Engine can’t set up Cloud Workers. Run libraos-core upgrade, then try again.",
      );
      expect(setups()).toEqual([]);

      cloudHelp =
        "usage: agentd cloud sync | balance | setup [--url URL] [--key-file FILE|-] [--dry-run] [--json]";
      // The version is the cache key: the same agentd version keeps its answer, a new one asks again.
      const upgraded = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        if (input.args.join(" ") === "help cloud") return Effect.succeed(output(cloudHelp));
        if (input.args[0] === "version") return Effect.succeed(output("agentd v0.1.15"));
        if (input.args.join(" ") === "handoff offer --help")
          return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
        if (input.args.join(" ") === "cloud setup --dry-run --json") return Effect.succeed(target);
        if (input.args[1] === "setup") return Effect.succeed(setup);
        if (input.args.join(" ") === "cloud balance --json")
          return Effect.succeed(
            output("a cloud handoff needs [cloud] url for the Job API. Run agentd cloud setup", 1),
          );
        return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
      });
      // A fresh install, [cloud] unset: v0.1.15's balance refusal is a setup problem, with the form.
      expect(yield* upgraded.cloudSetup({ cwd: null, includeBalance: true })).toMatchObject({
        canConfigure: true,
        setupUrl: libraos,
        problem: "setup",
      });
      expect(yield* upgraded.cloudSetup({ cwd: null, includeBalance: false })).toMatchObject({
        canConfigure: true,
        setupUrl: libraos,
      });
      expect(yield* upgraded.cloudConfigure({ key: `  ${key}\n`, url: libraos })).toEqual({
        balanceUsd: 12.5,
      });

      setup = output("cloud setup: the Job API refused the account key (HTTP 401)", 1);
      expect((yield* Effect.flip(upgraded.cloudConfigure({ key, url: libraos }))).message).toBe(
        "The Job API refused this account key. Copy the whole key and try again.",
      );
      setup = output(`cloud setup: unexpected answer near ${key}`, 1);
      expect((yield* Effect.flip(upgraded.cloudConfigure({ key, url: libraos }))).message).toBe(
        "unexpected answer near [redacted]",
      );
      expect(
        (yield* Effect.flip(upgraded.cloudConfigure({ key: "two\nlines", url: libraos }))).message,
      ).toBe("Paste the account key on one line.");

      // A separately hosted Job API ([cloud] url) is shown, and the key is bound to it.
      const custom = "https://jobs.example.com";
      target = output(`{"url":"${custom}","dry_run":true}`);
      expect(yield* upgraded.cloudSetup({ cwd: null, includeBalance: false })).toMatchObject({
        setupUrl: custom,
      });
      setup = output(`{"url":"${custom}","balance":{"available_usd":"3.00"}}`);
      expect(yield* upgraded.cloudConfigure({ key, url: custom })).toEqual({ balanceUsd: 3 });
      // agentd that won't say where: no destination, so the app asks for no key.
      target = output("cloud setup: use an HTTPS Job API URL", 1);
      expect(yield* upgraded.cloudSetup({ cwd: null, includeBalance: false })).toMatchObject({
        setupUrl: null,
      });
      for (const url of ["http://jobs.example.com", "https://u:p@jobs.example.com", "--url"]) {
        expect((yield* Effect.flip(upgraded.cloudConfigure({ key, url }))).message).toMatch(
          /Job API address/,
        );
      }

      const keyed = setups().filter(({ args }) => !args.includes("--dry-run"));
      expect(keyed.map(({ args, stdin }) => [args, stdin])).toEqual([
        ...Array.from({ length: 3 }, () => [
          ["cloud", "setup", "--url", libraos, "--key-file", "-", "--json"],
          `${key}\n`,
        ]),
        [["cloud", "setup", "--url", custom, "--key-file", "-", "--json"], `${key}\n`],
      ]);
      expect(
        setups()
          .filter(({ args }) => args.includes("--dry-run"))
          .every(({ stdin }) => stdin === undefined),
      ).toBe(true);
      expect(JSON.stringify(runs.map(({ args }) => args))).not.toContain(key);
    }),
  );

  it.effect("keeps a cloud reservation unless agentd positively refused the offer", () =>
    Effect.gen(function* () {
      const runs: Array<ReadonlyArray<string>> = [];
      let ledger = cloudLedger();
      let offerSays = "error: runner unavailable";
      let brokenFind = false;
      let breakLedgerOnOffer = false;
      let brokenJoin = false;
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input.args);
        if (brokenFind && input.args[0] === "find")
          return Effect.succeed(output("ledger locked", 1));
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.14"));
          case "remote get-url":
            return Effect.succeed(output("https://github.com/acme/app.git"));
          case "session join":
            return Effect.succeed(brokenJoin ? output("ledger busy", 1) : output("{}"));
          case "handoff offer":
            if (input.args.includes("--help"))
              return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
            brokenFind = breakLedgerOnOffer;
            return Effect.succeed(output(offerSays, 1));
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const input = {
        cwd: platform === "win32" ? "C:\\work\\app" : "/work/app",
        goal: "Fix the check",
        accept: [],
        check: "pnpm test",
        cloud: { modelAccess: "libraos", budget: "$5" },
      } as const;
      const keys = () =>
        runs
          .filter((args) => args.includes("--cloud") && !args.includes("--help"))
          .map((args) => args[args.indexOf("--idem") + 1]);

      // A runner error with no task on the ledger may still have reached the Job API.
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      // So may one whose ledger can't be read after it.
      breakLedgerOnOffer = true;
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      breakLedgerOnOffer = false;
      brokenFind = false;
      // A retry whose session join fails offers nothing and keeps the reservation too.
      brokenJoin = true;
      yield* Effect.flip(bridge.startTask(input));
      brokenJoin = false;
      expect(keys()).toHaveLength(2);
      offerSays = "error: 402: insufficient credit";
      expect((yield* Effect.flip(bridge.startTask(input))).message).toBe(
        "There is not enough LibraOS credit for this dollar cap.",
      );
      expect(new Set(keys()).size).toBe(1);
      // A refused retry says nothing of the earlier attempt: the next Start still reuses its key.
      yield* Effect.flip(bridge.startTask(input));
      expect(new Set(keys()).size).toBe(1);

      // A refusal never gives the key up, even for a reservation this Start made itself: a
      // different draft reuses it without asking, as does a Start after a failed session join.
      ledger = cloudLedger();
      runs.length = 0;
      yield* Effect.flip(bridge.startTask(input));
      const changed = yield* Effect.flip(
        bridge.startTask({ ...input, goal: "Update the changelog" }),
      );
      expect(changed).not.toHaveProperty("replaceSubmission");
      brokenJoin = true;
      yield* Effect.flip(bridge.startTask(input));
      brokenJoin = false;
      yield* Effect.flip(bridge.startTask(input));
      expect(keys()).toHaveLength(3);
      expect(new Set(keys()).size).toBe(1);

      // A first Start whose session join fails offered nothing: a different draft just replaces it.
      ledger = cloudLedger();
      brokenJoin = true;
      yield* Effect.flip(bridge.startTask(input));
      brokenJoin = false;
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "After a failed join" })),
      ).not.toHaveProperty("replaceSubmission");

      // A refused draft retried after a top-up, whose answer is lost: the release of the refused
      // offer says nothing of the retry, so a different draft must ask before replacing it.
      ledger = cloudLedger();
      runs.length = 0;
      offerSays = "error: 402: insufficient credit";
      yield* Effect.flip(bridge.startTask(input));
      offerSays = "error: runner unavailable";
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Retry aftermath" })),
      ).toMatchObject({ replaceSubmission: keys()[0] });
      expect(keys()).toHaveLength(2);
      // A release written late, by a server whose earlier offer was refused, doesn't apply either.
      ledger.pins.push({
        session: ledger.pins[0]!.session,
        text: releaseRecord(keys()[0]!, RESERVE_ATTEMPT),
      });
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Retry aftermath" })),
      ).toMatchObject({ replaceSubmission: keys()[0] });
      // A later attempt's refusal doesn't cover an earlier one still in flight: another server
      // pinned its attempt for the same draft and hasn't heard back.
      ledger = cloudLedger();
      runs.length = 0;
      offerSays = "error: 402: insufficient credit";
      yield* Effect.flip(bridge.startTask(input));
      ledger.pins.push({
        session: ledger.pins[0]!.session,
        text: attemptRecord(keys()[0]!, submissionFingerprint(input, "acme/app"), "other-server"),
      });
      yield* Effect.flip(bridge.startTask(input));
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Retry aftermath" })),
      ).toMatchObject({ replaceSubmission: keys()[0] });
      // Once that one is refused too, nothing is left open.
      ledger.pins.push({
        session: ledger.pins[0]!.session,
        text: releaseRecord(keys()[0]!, "other-server"),
      });
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Retry aftermath" })),
      ).not.toHaveProperty("replaceSubmission");
      // Two servers that reserved the same draft at once: one's refusal leaves the other's open.
      ledger = cloudLedger();
      runs.length = 0;
      offerSays = "error: 402: insufficient credit";
      yield* Effect.flip(bridge.startTask(input));
      const fingerprint = submissionFingerprint(input, "acme/app");
      ledger.pins.push({
        session: ledger.pins[0]!.session,
        text: reserveRecord(keys()[0]!, null, fingerprint, "other-server"),
      });
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Retry aftermath" })),
      ).toMatchObject({ replaceSubmission: keys()[0] });

      ledger = cloudLedger();
      runs.length = 0;
      yield* Effect.flip(bridge.startTask(input));
      yield* Effect.flip(bridge.startTask(input));
      yield* Effect.flip(bridge.startTask(input));
      offerSays = "error: runner unavailable";

      // After a refusal, a different draft whose outcome is lost is the one a third must replace.
      offerSays = "error: runner unavailable";
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Bump the version" })),
      ).toMatchObject({ outcomeUnknown: true });
      const third = yield* Effect.flip(bridge.startTask({ ...input, goal: "Tidy the README" }));
      expect(third).toMatchObject({ replaceSubmission: keys()[0] });
      expect(keys()).toHaveLength(4);
      // Its retry, and the replaced draft once confirmed, go under the same key without asking.
      yield* Effect.flip(bridge.startTask({ ...input, goal: "Bump the version" }));
      yield* Effect.flip(
        bridge.startTask({
          ...input,
          goal: "Tidy the README",
          cloud: { ...input.cloud, replaceSubmission: keys()[0]! },
        }),
      );
      expect(
        yield* Effect.flip(bridge.startTask({ ...input, goal: "Bump the version" })),
      ).toMatchObject({ replaceSubmission: keys()[0] });
      expect(keys()).toHaveLength(6);
      expect(new Set(keys()).size).toBe(1);
    }),
  );

  it.effect("keeps one cloud key while another server shares the ledger", () =>
    Effect.gen(function* () {
      const ledger = cloudLedger();
      const offers: Array<string> = [];
      const secondOffering = yield* Deferred.make<void>();
      const secondMayFinish = yield* Deferred.make<void>();
      const platform = yield* HostProcess.Platform;
      const input = {
        cwd: platform === "win32" ? "C:\\work\\app" : "/work/app",
        goal: "Fix the check",
        accept: [],
        check: "pnpm test",
        cloud: { modelAccess: "libraos", budget: "$5" },
      } as const;
      const server = (
        offer: (args: ReadonlyArray<string>) => Effect.Effect<ProcessRunner.ProcessRunOutput>,
      ) =>
        makeBridge({ AGENTD_BIN: process.execPath }, (run) => {
          const recorded = ledger.answer(run.args);
          if (recorded !== null) return Effect.succeed(recorded);
          switch (run.args.slice(0, 2).join(" ")) {
            case "version":
              return Effect.succeed(output("agentd v0.1.14"));
            case "remote get-url":
              return Effect.succeed(output("https://github.com/acme/app.git"));
            case "session join":
              return Effect.succeed(output("{}"));
            case "handoff offer":
              if (run.args.includes("--help"))
                return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
              offers.push(run.args[run.args.indexOf("--idem") + 1]!);
              return offer(run.args);
            default:
              return Effect.die(`unexpected agentd ${run.args.join(" ")}`);
          }
        });
      // The second server's offer reaches agentd and is slow to answer; it makes a task.
      const other = yield* server((args) =>
        Deferred.succeed(secondOffering, undefined).pipe(
          Effect.andThen(Deferred.await(secondMayFinish)),
          Effect.andThen(
            Effect.sync(() => {
              ledger.record(args, "hof-aabbcc", "queued");
              return output('{"handoff":"hof-aabbcc","cloud":{"state":"queued"}}');
            }),
          ),
        ),
      );
      type Start = ReturnType<typeof other.startTask>;
      let second: Fiber.Fiber<Effect.Success<Start>, Effect.Error<Start>> | undefined;
      // The first is refused before a task; the second picks up its reservation in that window.
      const first = yield* server(() =>
        Effect.gen(function* () {
          if (second === undefined) {
            second = yield* Effect.forkChild(other.startTask(input));
            yield* Deferred.await(secondOffering);
          }
          return output("error: 402: insufficient credit", 1);
        }),
      );
      yield* Effect.flip(first.startTask(input));
      // The next Start on the first server may not offer under a fresh key.
      yield* Effect.flip(first.startTask(input));
      yield* Deferred.succeed(secondMayFinish, undefined);
      yield* Fiber.join(second!);
      expect(offers).toHaveLength(3);
      expect(new Set(offers).size).toBe(1);
    }),
  );

  it.effect("names cloud refusals in one line, and reads GitHub origins in every form", () =>
    Effect.gen(function* () {
      let origin = "";
      let refusal = "";
      const ledger = cloudLedger();
      const offers: Array<ReadonlyArray<string>> = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.14"));
          case "help cloud":
            return Effect.succeed(output("usage: agentd cloud sync | balance"));
          case "remote get-url":
            return origin === "timeout"
              ? Effect.fail(
                  new ProcessRunner.ProcessTimeoutError({
                    command: "git",
                    argumentCount: 4,
                    timeoutMs: 5000,
                  }),
                )
              : origin.startsWith("exit ")
                ? Effect.succeed({
                    ...output("", Number(origin.slice(5, 8))),
                    stderr: origin.slice(9),
                  })
                : Effect.succeed(output(`${origin}\n`));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            if (input.args.includes("--help"))
              return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
            offers.push(input.args);
            return Effect.succeed(output(`error: ${refusal}`, 1));
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const cwd = platform === "win32" ? "C:\\work\\app" : "/work/app";
      for (const [form, project] of [
        ["https://github.com/Acme/App.git", "acme/app"],
        ["https://www.github.com/acme/app/", "acme/app"],
        ["https://ci-bot@github.com/acme/app", "acme/app"],
        ["git+ssh://git@github.com/acme/app.git", "acme/app"],
        ["ssh://git@github.com:22/acme/app.git", "acme/app"],
        ["ssh://git@ssh.github.com:443/acme/app.git", "acme/app"],
        ["git@github.com:acme/task-sk-0123456789abcdef.git", "acme/task-sk-0123456789abcdef"],
        ["git@github.com:acme/app.js", "acme/app.js"],
        ["https://github.com/acme/..", null],
        ["https://github.example.com/acme/app.git", null],
        ["git@gitlab.com:acme/app.git", null],
        ["https://github.com/acme", null],
      ] as const) {
        origin = form;
        expect((yield* bridge.cloudSetup({ cwd, includeBalance: false })).project, form).toBe(
          project,
        );
      }
      // git not answering, or failing to read the checkout, is not "no GitHub origin": the app
      // must retry, never run it here.
      for (const unknown of [
        "timeout",
        "exit 128 fatal: unable to access '.git/config': Permission denied",
      ]) {
        origin = unknown;
        expect(yield* bridge.cloudSetup({ cwd, includeBalance: false }), unknown).toMatchObject({
          project: null,
          checkoutUnknown: true,
        });
      }
      for (const missing of [
        "exit 002 error: No such remote 'origin'",
        "exit 128 fatal: not a git repository (or any of the parent directories): .git",
      ]) {
        origin = missing;
        const setup = yield* bridge.cloudSetup({ cwd, includeBalance: false });
        expect(setup.project, missing).toBeNull();
        expect(setup.checkoutUnknown, missing).not.toBe(true);
      }

      origin = "git@github.com:acme/app.git";
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const keyFile = path.join(cwd, "risk-assessment-keys", "byok", "cloud-key", "openai.txt");
      const input = {
        cwd,
        goal: "Fix the check",
        accept: [],
        check: null,
        cloud: { modelAccess: "byok", budget: "$5", openaiKeyFile: keyFile },
      } as const;
      for (const [said, reason] of [
        [
          "the GitHub App is not installed on acme/app: the repository's owner installs it once",
          "The repository owner must install the Cloud Workers GitHub App on this repository.",
        ],
        [
          `cloud.openai_key_file ${keyFile} can be read or written by others (mode 644)`,
          `${keyFile} can be read by other users. Run chmod 600 ${keyFile}, then try again.`,
        ],
        [
          "--model-access subscription is not offered through an agentd server",
          "Submit cloud tasks from a local LibraOS Engine session, not through a team server.",
        ],
        [
          "the Claude subscription is not enabled for this account",
          "Running on your Claude subscription isn’t available yet. Use LibraOS or your API key.",
        ],
        ["402: insufficient credit", "There is not enough LibraOS credit for this dollar cap."],
        [
          "set [cloud] url first",
          "Cloud Workers aren’t set up. Check the cloud configuration and account key file.",
        ],
      ] as const) {
        refusal = said;
        expect((yield* Effect.flip(bridge.startTask(input))).message, said).toBe(reason);
      }
      expect(offers.every((args) => args.includes(keyFile))).toBe(true);
      // Each refusal made no task: the next Start reuses its key without asking.
      expect(new Set(offers.map((args) => args[args.indexOf("--idem") + 1])).size).toBe(1);
      refusal = `cloud.openai_key_file ${keyFile} can be read or written by others (mode 644)`;
      const other = { ...input, goal: "Update the changelog" };
      const shared = yield* Effect.flip(bridge.startTask(other));
      expect(shared).toMatchObject({ privateFile: keyFile });
      expect(shared).not.toHaveProperty("replaceSubmission");
    }),
  );

  it.effect("sends the joinTeam ticket on stdin, never in the arguments", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        return Effect.succeed(output("joined\n"));
      });
      const ticket = "adt_0123456789abcdefXYZ";
      yield* bridge.joinTeam({ server: "https://agentd.example/team/", ticket: ` ${ticket} ` });
      expect(runs.map((run) => [run.args, run.stdin])).toEqual([
        [
          ["connect", "--server", "https://agentd.example/team", "--ticket-file", "-"],
          `${ticket}\n`,
        ],
      ]);
    }),
  );

  it.effect("makes a backup to the device's public key and keeps only the newest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const older = "agentd-backup-20261120T080000Z-00000000.age";
      yield* fs.writeFileString(`${dir}/${older}`, "old");
      yield* fs.writeFileString(`${dir}/keep.txt`, "not ours");
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        return Effect.succeed(
          output(
            JSON.stringify({
              path: input.args[3],
              size: 2048,
              sha256: "a".repeat(64),
              created: "2026-11-21T10:15:00Z",
              names: ["ledger.db"],
            }),
          ),
        );
      });
      const recipient = `age1${"q".repeat(58)}`;
      const made = yield* bridge.backupCreate({ recipient }, dir);
      expect(made).toEqual({
        fileName: expect.stringMatching(/^agentd-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.age$/),
        bytes: 2048,
        sha256: "a".repeat(64),
        created: "2026-11-21T10:15:00Z",
      });
      expect(runs.map((run) => [run.args, run.stdin])).toEqual([
        [
          ["backup", "create", "-o", `${dir}/${made.fileName}`, "--recipient", recipient, "--json"],
          undefined,
        ],
      ]);
      expect([...(yield* fs.readDirectory(dir))].sort()).toEqual(["keep.txt"]);

      // A recipient that is not an age public key, such as a private key, reaches no agentd.
      for (const bad of [
        `AGE-SECRET-KEY-1${"Q".repeat(58)}`,
        `-${recipient}`,
        `age1${"b".repeat(58)}`,
      ]) {
        const refused = yield* Effect.flip(bridge.backupCreate({ recipient: bad }, dir));
        expect(refused).toMatchObject({ message: "not an age public key (age1...)" });
      }
      expect(runs).toHaveLength(1);

      // A failed backup removes no earlier one.
      const failing = yield* makeBridge({ AGENTD_BIN: process.execPath }, () =>
        Effect.succeed(output("", 1)),
      );
      yield* fs.writeFileString(`${dir}/${older}`, "old");
      yield* Effect.flip(failing.backupCreate({ recipient }, dir));
      expect([...(yield* fs.readDirectory(dir))].sort()).toEqual([older, "keep.txt"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("combines issue and repository holdings without naming the user or finished work", () =>
    Effect.gen(function* () {
      const cwd = "C:\\work\\app";
      const issue = "acme/app#42";
      const bob = { user: "Bob", via: "server", handoff: "hof-abcd42" };
      const file = { ...bob, resource: "repo:github.com/acme/app#src/login.ts" };
      const results = new Map([
        [cwd, { resource: "tree:github.com/acme/app@feature", holders: [] }],
        [
          issue,
          {
            holders: [
              { ...bob, resource: issue, activity: "Fix login", state: "claimed" },
              file,
              { user: "Les", via: "server", resource: issue, handoff: "hof-abcd43" },
              { user: "Tess", resource: issue, handoff: "hof-abcd44", state: "done" },
            ],
          },
        ],
        [
          "acme/app",
          {
            holders: [
              { user: "work-account", resource: "tree:github.com/acme/app@elsewhere" },
              { ...bob, path: "/work/app", resource: "tree:github.com/acme/app@elsewhere" },
            ],
          },
        ],
        [
          "repo:github.com/acme/app#",
          {
            holders: [file, { user: "Ari", resource: "repo:github.com/acme/app#README.md" }],
          },
        ],
      ]);
      const bridge = yield* makeBridge(
        { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
        ({ args }) => {
          if (args[0] === "doctor") return Effect.succeed(output(DOCTOR_JSON, 1));
          const answer = args[0] === "who" && results.get(args[1]!);
          return answer
            ? Effect.succeed(output(JSON.stringify({ ...answer, server: "https://team.example" })))
            : Effect.die(`unexpected agentd ${args.join(" ")}`);
        },
      );

      expect(yield* bridge.taskOthers({ cwd, issue })).toEqual([
        {
          person: "Bob",
          work: "hof-abcd42",
          activity: "Fix login",
          paths: ["src/login.ts", "/work/app"],
        },
        { person: "Ari", work: null, activity: null, paths: ["README.md"] },
      ]);
    }),
  );

  it.effect("does not ask who when the environment is off a team", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, ({ args }) =>
        args[0] === "doctor"
          ? Effect.succeed(
              output(
                '{"checks":[{"id":"server","status":"pass","detail":"not joined to an agentd server: local mode"}]}',
              ),
            )
          : Effect.die(`unexpected agentd ${args.join(" ")}`),
      );

      expect(yield* bridge.taskOthers({ cwd: "/repo", issue: null })).toEqual([]);
    }),
  );

  it.effect.each(["error", "server_note", "slow"] as const)(
    "discards partial overlap answers when a who lookup returns %s",
    (failure) =>
      Effect.gen(function* () {
        const issueStarted = yield* Deferred.make<void>();
        const bridge = yield* makeBridge(
          { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
          ({ args }) => {
            if (args[0] === "doctor") return Effect.succeed(output(DOCTOR_JSON, 1));
            if (args[0] === "who" && args[1] === "/repo") {
              return Effect.succeed(
                output(
                  '{"server":"https://team.example","holders":[{"user":"Bob","path":"/repo"}]}',
                ),
              );
            }
            if (args[0] === "who" && args[1] === "acme/app#42") {
              switch (failure) {
                case "error":
                  return Effect.succeed(output("lookup failed", 1));
                case "server_note":
                  return Effect.succeed(
                    output(
                      '{"server":"https://team.example","server_note":"lookup failed","holders":[]}',
                    ),
                  );
                case "slow":
                  return Deferred.succeed(issueStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
              }
            }
            return Effect.die(`unexpected agentd ${args.join(" ")}`);
          },
        );

        const result = yield* bridge
          .taskOthers({ cwd: "/repo", issue: "acme/app#42" })
          .pipe(Effect.forkScoped);
        if (failure === "slow") {
          yield* Deferred.await(issueStarted);
          yield* TestClock.adjust("3 seconds");
        }
        expect(yield* Fiber.join(result)).toEqual([]);
      }),
  );

  it.effect("reads the estimate for the draft's size and suggests a check from the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const runs: Array<ReadonlyArray<string>> = [];
      let estimate = output('{"high":4.98,"low":1.78,"median":3.11,"n":846,"type":"small"}');
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, ({ args }) => {
        runs.push(args);
        return args[1] === "estimate" ? Effect.succeed(estimate) : Effect.die("unexpected");
      });

      expect(yield* bridge.taskDefaults({ cwd, size: "small" })).toEqual({
        estimate: { type: "small", low: 1.78, median: 3.11, high: 4.98, jobs: 846 },
        check: null,
      });
      yield* fs.writeFileString(path.join(cwd, "go.mod"), "module example.com/x\n");
      yield* fs.writeFileString(path.join(cwd, "package.json"), '{"scripts":{"test":"vitest"}}');
      yield* fs.writeFileString(path.join(cwd, "pnpm-lock.yaml"), "");
      estimate = output("agentd: no ledger", 1);
      expect(yield* bridge.taskDefaults({ cwd, size: "" })).toEqual({
        estimate: null,
        check: "pnpm test",
      });
      expect(runs).toEqual([
        ["handoff", "estimate", "--type", "small", "--json"],
        ["handoff", "estimate", "--type", "implement", "--json"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads the Git identity in the task's folder and sets it globally", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const repo = path.join(home, "repo");
      yield* fs.makeDirectory(repo);
      const real = yield* ProcessRunner.make();
      // Real git, with its global config in the temporary home instead of this user's.
      const gitEnv = {
        GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: home,
      };
      yield* real.run({ command: "git", args: ["init", "--quiet", repo], env: gitEnv });
      const runs: Array<{ args: ReadonlyArray<string>; cwd: string | undefined }> = [];
      const bridge = yield* makeBridge({ PATH: "" }, (input) => {
        runs.push({ args: input.args, cwd: input.cwd });
        return real.run({ ...input, env: gitEnv });
      });

      expect(yield* bridge.gitIdentity({ cwd: repo })).toEqual({ name: "", email: "" });
      yield* bridge.setGitIdentity({ name: " Ada Lovelace ", email: "ada@example.com" });
      expect(yield* bridge.gitIdentity({ cwd: repo })).toEqual({
        name: "Ada Lovelace",
        email: "ada@example.com",
      });
      expect(yield* fs.readFileString(gitEnv.GIT_CONFIG_GLOBAL)).toContain("name = Ada Lovelace");
      expect(runs).toEqual([
        { args: ["config", "--get", "user.name"], cwd: repo },
        { args: ["config", "--get", "user.email"], cwd: repo },
        { args: ["config", "--global", "--", "user.name", "Ada Lovelace"], cwd: undefined },
        { args: ["config", "--global", "--", "user.email", "ada@example.com"], cwd: undefined },
        { args: ["config", "--get", "user.name"], cwd: repo },
        { args: ["config", "--get", "user.email"], cwd: repo },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
