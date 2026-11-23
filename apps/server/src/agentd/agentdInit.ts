import type { AgentdError, AgentdSetupState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../processRunner.ts";
import { AgentdBridge } from "./AgentdBridge.ts";
import { agentdArgs } from "./agentdCommands.ts";

// `agentd init` for this environment, run when the person clicks Accept in the app. agentd v0.1.13
// accepts its EULA only by `yes` typed at a terminal, so init runs in a pseudo-terminal; the app
// types `yes` at that one prompt, once, and stops init if it asks anything else.

export class AgentdInit extends Context.Service<
  AgentdInit,
  {
    /** Starts init unless it runs already; answers at once with the run's state. */
    readonly start: Effect.Effect<AgentdSetupState, AgentdError>;
    readonly subscribe: Stream.Stream<AgentdSetupState>;
  }
>()("t3/agentd/agentdInit") {}

const EULA_PROMPT = "Type yes to accept:";
// An unfinished line still this long after the last output is init waiting for an answer.
const QUIET = Duration.seconds(2);
const RUN_LIMIT = Duration.minutes(10);
const OUTPUT_LIMIT = 64 * 1024;
const IDLE: AgentdSetupState = {
  phase: "idle",
  attempt: 0,
  output: "",
  exitCode: null,
  stopped: null,
};

/** What init asks on its unfinished last line: the EULA, something else, or nothing. */
export function initPrompt(line: string): "eula" | "other" | null {
  const text = line.trimEnd();
  if (text.endsWith(EULA_PROMPT)) return "eula";
  return /[:?>\])]$/.test(text) ? "other" : null;
}

// Escape sequences (colours, cursor moves; Windows' console host sends many) and carriage returns.
const ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function terminalText(raw: string): string {
  return raw.replace(ESCAPES, "").replace(/\r+\n/g, "\n").replace(/\r/g, "");
}

// agentd v0.1.15 init exits 3 when setup finished but no Claude Code, Codex or opencode was found;
// the AgentD page's checks then say what to install.
const INIT_NO_CODING_CLIENT = 3;

export function initPhase(
  exitCode: number | null,
  stopped: AgentdSetupState["stopped"],
): "succeeded" | "failed" {
  return stopped === null && (exitCode === 0 || exitCode === INIT_NO_CODING_CLIENT)
    ? "succeeded"
    : "failed";
}

function lastLine(text: string): string {
  return text.slice(text.lastIndexOf("\n") + 1);
}

type PtyEvent =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number };

const make = Effect.fn("AgentdInit.make")(function* () {
  const bridge = yield* AgentdBridge;
  const runner = yield* ProcessRunner.ProcessRunner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const env = yield* HostProcess.Environment;
  const scope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<AgentdSetupState>(IDLE);
  const lock = yield* Semaphore.make(1);
  // Whether an agentd version takes a non-interactive EULA flag, read from its `init --help` once.
  const acceptFlag = new Map<string, boolean>();

  const read = (command: string, argv: ReadonlyArray<string>) =>
    runner.run({ command, args: argv, timeout: Duration.seconds(30) }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout + output.stderr : "")),
      Effect.orElseSucceed(() => ""),
    );

  const hasAcceptFlag = Effect.fn("AgentdInit.hasAcceptFlag")(function* (command: string) {
    const version = `${command}\n${(yield* read(command, agentdArgs.version())).trim()}`;
    const known = acceptFlag.get(version);
    if (known !== undefined) return known;
    const found = (yield* read(command, agentdArgs.initHelp())).includes("--accept-eula");
    acceptFlag.set(version, found);
    return found;
  });

  const run = Effect.fn("AgentdInit.run")(function* (command: string, flag: boolean) {
    const home = yield* HostProcess.HomeDirectory;
    const spawned = yield* pty
      .spawn({
        shell: command,
        args: [...agentdArgs.init(flag)],
        cwd: home,
        cols: 100,
        rows: 30,
        env: { ...env },
      })
      .pipe(Effect.option);
    if (spawned._tag === "None") {
      yield* SubscriptionRef.update(state, (s): AgentdSetupState => ({
        ...s,
        phase: "failed",
        stopped: "spawn",
      }));
      return;
    }
    const proc = spawned.value;
    let raw = "";
    let answered = false;
    let exited = false;
    let stopped: AgentdSetupState["stopped"] = null;
    let exitCode: number | null = null;
    const stop = (why: NonNullable<AgentdSetupState["stopped"]>) =>
      Effect.sync(() => {
        if (stopped !== null || exited) return;
        stopped = why;
        proc.kill();
      });
    const quiet = yield* FiberHandle.make();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!exited) proc.kill();
      }),
    );
    yield* Effect.forkScoped(Effect.sleep(RUN_LIMIT).pipe(Effect.andThen(stop("timeout"))));

    const onOutput = Effect.fnUntraced(function* () {
      const text = terminalText(raw);
      yield* SubscriptionRef.update(state, (s) => ({ ...s, output: text.slice(-OUTPUT_LIMIT) }));
      if (!answered && initPrompt(lastLine(text)) === "eula") {
        answered = true;
        proc.write("yes\r");
        return;
      }
      yield* FiberHandle.run(
        quiet,
        Effect.sleep(QUIET).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              // A second EULA prompt is init asking again, not the one the person accepted.
              initPrompt(lastLine(terminalText(raw))) === null ? Effect.void : stop("prompt"),
            ),
          ),
        ),
      );
    });

    yield* Stream.callback<PtyEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const offData = proc.onData((data) => {
            Queue.offerUnsafe(queue, { type: "data", data });
          });
          const offExit = proc.onExit((event) => {
            Queue.offerUnsafe(queue, { type: "exit", exitCode: event.exitCode });
            Queue.endUnsafe(queue);
          });
          return () => {
            offData();
            offExit();
          };
        }),
        (off) => Effect.sync(off),
      ),
    ).pipe(
      Stream.runForEach((event) => {
        if (event.type === "exit") {
          exited = true;
          exitCode = event.exitCode;
          return FiberHandle.clear(quiet);
        }
        raw = (raw + event.data).slice(-4 * OUTPUT_LIMIT);
        return onOutput();
      }),
    );
    yield* SubscriptionRef.update(state, (s): AgentdSetupState => ({
      ...s,
      phase: initPhase(exitCode, stopped),
      exitCode,
      stopped,
    }));
  });

  const start: AgentdInit["Service"]["start"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.phase === "running") return current;
        const command = yield* bridge.setupBinary;
        const flag = yield* hasAcceptFlag(command);
        const running: AgentdSetupState = {
          ...IDLE,
          phase: "running",
          attempt: current.attempt + 1,
        };
        yield* SubscriptionRef.set(state, running);
        // The run outlives the request: init goes on if every client disconnects.
        yield* Effect.forkIn(
          Effect.scoped(run(command, flag)).pipe(
            Effect.ensuring(
              SubscriptionRef.update(state, (s): AgentdSetupState =>
                s.phase === "running" ? { ...s, phase: "failed" } : s,
              ),
            ),
          ),
          scope,
        );
        return running;
      }),
    )
    .pipe(Effect.withSpan("AgentdInit.start"));

  return AgentdInit.of({ start, subscribe: SubscriptionRef.changes(state) });
});

export const layer = Layer.effect(AgentdInit, make());
