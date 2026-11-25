import {
  AgentdCommandError,
  type AgentdError,
  AgentdWorkerTool,
  type AgentdTeamNodeInput,
  type AgentdTeamNodeStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { AgentdBridge } from "./AgentdBridge.ts";

// This environment as a team node: the one `agentd worker --accept-server-work` child the server
// runs while the person has opted in, and the busy signal while they use the app.

export class AgentdTeamNode extends Context.Service<
  AgentdTeamNode,
  {
    readonly subscribe: Stream.Stream<AgentdTeamNodeStatus, AgentdError>;
    readonly set: (input: AgentdTeamNodeInput) => Effect.Effect<AgentdTeamNodeStatus, AgentdError>;
    /** The person used the app: declare foreground work, at most once a minute, while on. */
    readonly foreground: Effect.Effect<{}, AgentdError>;
  }
>()("t3/agentd/AgentdTeamNode") {}

const ACTIVE_MINUTES = 10;
const SIGNAL_EVERY = Duration.minutes(1);
const TOOLS = AgentdWorkerTool.literals;
// Run by agentd with sh in the leased worktree; agentd sets AGENTD_JOB_GOAL.
const NODE_COMMANDS: Record<AgentdWorkerTool, string> = {
  claude:
    'claude -p "$AGENTD_JOB_GOAL" --dangerously-skip-permissions --disallowedTools WebFetch WebSearch',
  codex: 'codex exec --full-auto "$AGENTD_JOB_GOAL"',
  opencode: 'opencode run "$AGENTD_JOB_GOAL"',
};

function teamNodeArgs(tool: AgentdWorkerTool, repo: string): ReadonlyArray<string> {
  return [
    "worker",
    "--kind",
    "desktop",
    "--accept-server-work",
    "--max",
    "1",
    "--active-window",
    `${ACTIVE_MINUTES}m`,
    "--tools",
    tool,
    "--repo",
    repo,
    "--command",
    NODE_COMMANDS[tool],
    "--push",
  ];
}

const LEASED = /\bleased (hof-[0-9a-f]{6,32}), attempt \d+/;
// agentd prints one of these once per lease when it ends (workercmd's leaseJob.end).
const ENDED = /\b(hof-[0-9a-f]{6,32}): (?:delivered\b|stopped:|not delivered|failed:|declined:)/;

/** The task a running worker holds after it printed `line`, given the one it held before. */
export function taskAfterLine(task: string | null, line: string): string | null {
  const leased = LEASED.exec(line);
  if (leased) return leased[1]!;
  const ended = ENDED.exec(line);
  return ended && ended[1] === task ? null : task;
}

/** Wait before restarting after `failures` exits in a row: 5 s doubling, at most 5 minutes. */
export function restartDelay(failures: number): Duration.Duration {
  return Duration.seconds(Math.min(300, 5 * 2 ** Math.max(0, failures - 1)));
}
// A worker that ran this long before it exited starts the backoff over.
const HEALTHY_RUN = Duration.minutes(2);

const Choice = Schema.Struct({
  on: Schema.Boolean,
  tool: Schema.NullOr(AgentdWorkerTool),
  repo: Schema.NullOr(Schema.String),
});
type Choice = typeof Choice.Type;
const OFF: Choice = { on: false, tool: null, repo: null };
const decodeChoice = Schema.decodeUnknownEffect(Schema.fromJsonString(Choice));

type Node = Omit<AgentdTeamNodeStatus, "tools">;
type NodeState = AgentdTeamNodeStatus["state"];

const commandError = (message: string) => new AgentdCommandError({ message, notSetUp: false });

const make = Effect.fn("AgentdTeamNode.make")(function* () {
  const bridge = yield* AgentdBridge;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const hostServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HostProcess.Platform, platform),
    );

  // The person's choice, per environment: kept beside the server's own settings.
  const choicePath = pathService.join(config.stateDir, "agentd-team-node.json");
  const kept = yield* fs.readFileString(choicePath).pipe(
    Effect.flatMap(decodeChoice),
    Effect.orElseSucceed(() => OFF),
  );
  const saveChoice = (choice: Choice) =>
    fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(choicePath, JSON.stringify(choice))),
      Effect.mapError(() => commandError("The team node choice could not be saved.")),
    );

  const node = yield* SubscriptionRef.make<Node>({
    ...kept,
    state: "off",
    task: null,
    note: null,
  });
  const runner = yield* FiberHandle.make();
  const lock = yield* Semaphore.make(1);
  let lastSignal: number | null = null;

  const installedTools = Effect.forEach(TOOLS, (tool) =>
    hostServices(resolveCommandPath(tool, { env })).pipe(
      Effect.map((found) => (found === null ? [] : [tool])),
      Effect.orElseSucceed(() => []),
    ),
  ).pipe(Effect.map((found) => found.flat()));

  const withTools = (value: Node) =>
    installedTools.pipe(
      Effect.map((tools) => ({ ...value, tools }) satisfies AgentdTeamNodeStatus),
    );

  // One run of the worker: resolves when it exits, with the last thing it said.
  const runOnce = (tool: AgentdWorkerTool, repo: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const binary = yield* bridge.binary;
        const spawn = yield* hostServices(resolveSpawnCommand(binary, teamNodeArgs(tool, repo)));
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawn.command, spawn.args, {
              cwd: repo,
              shell: spawn.shell,
              windowsHide: true,
              forceKillAfter: Duration.seconds(10),
            }),
          )
          .pipe(
            Effect.mapError(() =>
              commandError(`LibraOS Engine at ${binary} could not be started.`),
            ),
            Effect.catchDefect(() =>
              Effect.fail(commandError("LibraOS Engine could not be started.")),
            ),
          );
        yield* SubscriptionRef.update(node, (n): Node => ({ ...n, state: "waiting", note: null }));
        let said = "";
        const read = (output: typeof child.stdout) =>
          output.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              if (line.trim() !== "") said = line.trim();
              return SubscriptionRef.update(node, (n): Node => {
                const task = taskAfterLine(n.task, line);
                const state: NodeState = task === null ? "waiting" : "working";
                return task === n.task ? n : { ...n, task, state };
              });
            }),
            Effect.ignore,
          );
        yield* Effect.all([read(child.stdout), read(child.stderr)], { concurrency: 2 });
        const code = yield* child.exitCode.pipe(Effect.orElseSucceed(() => null));
        return said || `LibraOS Engine worker ended (${code ?? "unknown"}).`;
      }),
    );

  // Restarts the worker with backoff until interrupted; interrupting closes its scope, which
  // ends the child it spawned (and only that one).
  const supervise = Effect.fn("AgentdTeamNode.supervise")(function* (
    tool: AgentdWorkerTool,
    repo: string,
  ) {
    let failures = 0;
    while (true) {
      const started = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(runOnce(tool, repo));
      const ran = (yield* Clock.currentTimeMillis) - started;
      failures = ran >= Duration.toMillis(HEALTHY_RUN) ? 1 : failures + 1;
      const note = Exit.isSuccess(exit)
        ? exit.value
        : Exit.findErrorOption(exit).pipe((error) =>
            error._tag === "Some" ? error.value.message : "LibraOS Engine worker failed.",
          );
      yield* SubscriptionRef.update(node, (n): Node => ({
        ...n,
        state: "failed",
        task: null,
        note,
      }));
      yield* Effect.sleep(restartDelay(failures));
    }
  });

  const start = (tool: AgentdWorkerTool, repo: string) =>
    FiberHandle.run(runner, supervise(tool, repo)).pipe(Effect.asVoid);

  const stop = FiberHandle.clear(runner).pipe(
    Effect.andThen(
      SubscriptionRef.update(node, (n): Node => ({ ...n, state: "off", task: null, note: null })),
    ),
  );

  if (kept.on && kept.tool !== null && kept.repo !== null) yield* start(kept.tool, kept.repo);

  const set = Effect.fn("AgentdTeamNode.set")(function* (input: AgentdTeamNodeInput) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (!input.on) {
          yield* stop;
          const current = yield* SubscriptionRef.get(node);
          yield* saveChoice({ on: false, tool: current.tool, repo: current.repo });
          yield* SubscriptionRef.update(node, (n) => ({ ...n, on: false }));
          return yield* withTools(yield* SubscriptionRef.get(node));
        }
        if (!(yield* installedTools).includes(input.tool)) {
          return yield* commandError(`${input.tool} is not installed on this environment.`);
        }
        const isDirectory = yield* fs.stat(input.repo).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (!isDirectory) return yield* commandError(`${input.repo} is not a folder here.`);
        const server = (yield* bridge.status).teamServer;
        if (typeof server !== "string" || server === "") {
          return yield* commandError("Join a team first: this environment has no team server.");
        }
        if (input.ticket !== undefined && input.ticket.trim() !== "") {
          yield* bridge.enrolWorker(server, input.ticket);
        }
        yield* stop;
        yield* saveChoice({ on: true, tool: input.tool, repo: input.repo });
        yield* SubscriptionRef.update(node, (n) => ({
          ...n,
          on: true,
          tool: input.tool,
          repo: input.repo,
        }));
        lastSignal = null;
        yield* start(input.tool, input.repo);
        return yield* withTools(yield* SubscriptionRef.get(node));
      }),
    );
  });

  const foreground: AgentdTeamNode["Service"]["foreground"] = Effect.gen(function* () {
    if (!(yield* SubscriptionRef.get(node)).on) return {};
    const now = yield* Clock.currentTimeMillis;
    if (lastSignal !== null && now - lastSignal < Duration.toMillis(SIGNAL_EVERY)) return {};
    lastSignal = now;
    yield* bridge.foreground(ACTIVE_MINUTES);
    return {};
  }).pipe(Effect.withSpan("AgentdTeamNode.foreground"));

  return AgentdTeamNode.of({
    subscribe: Stream.unwrap(
      Effect.map(installedTools, (tools) =>
        SubscriptionRef.changes(node).pipe(Stream.map((value) => ({ ...value, tools }))),
      ),
    ),
    set,
    foreground,
  });
});

export const layer = Layer.effect(AgentdTeamNode, make());
