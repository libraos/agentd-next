import * as NodeOS from "node:os";

import {
  AgentdApprovalListJson,
  AgentdCommandError,
  AgentdDoctorJson,
  type AgentdError,
  AgentdHandoffListJson,
  AgentdHandoffShowJson,
  AgentdInboxListJson,
  AgentdInstallRecord,
  AgentdNode,
  AgentdNotFoundError,
  AgentdUserListJson,
  AgentdWhoJson,
  type AgentdWorkerGateway,
  AgentdWorkerTool,
  type AgentdApproval,
  type AgentdBackupCreated,
  type AgentdBackupCreateInput,
  type AgentdCloudSetup,
  type AgentdCloudReview,
  type AgentdCloudReviewInput,
  type AgentdCloudSetupInput,
  type AgentdCloudConfigureInput,
  type AgentdCloudConfigured,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudKeyFileInput,
  type AgentdServicesProblem,
  type AgentdServicesRepairResult,
  type AgentdServicesRepairInput,
  type AgentdTaskDefaults,
  type AgentdTaskDefaultsInput,
  type AgentdGitIdentity,
  type AgentdGitIdentityInput,
  type AgentdSetGitIdentityInput,
  type AgentdCloudTaskInput,
  type AgentdCommandOutput,
  type AgentdConnectAgentInput,
  type AgentdEula,
  type AgentdInboxItem,
  type AgentdPermissionModeState,
  type AgentdJoinTeamInput,
  type AgentdPeople,
  type AgentdPeopleInput,
  type AgentdStartTaskInput,
  type AgentdStartTaskResult,
  type AgentdBlockingTask,
  type AgentdRetryStartInput,
  type AgentdStatus,
  type AgentdStopTaskInput,
  type AgentdTask,
  type AgentdTaskInput,
  type AgentdTaskRow,
  type AgentdTaskOther,
  type AgentdTaskOthersInput,
  type OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeAgentdCloud } from "./agentdCloud.ts";
import { makeCloudReview } from "./agentdCloudReview.ts";
import {
  AgentdArgumentError,
  agentdArgs,
  agentdTicket,
  HANDOFF_PAGE_SIZE,
} from "./agentdCommands.ts";
import * as AgentdJson from "./agentdJson.ts";
import { AGENTD_BACKUP_FILE, agentdBackupFileName } from "./agentdBackup.ts";
import { blockingRefusal } from "./blockedStart.ts";
import { findEngine } from "./enginePath.ts";
import type { WorkerGatewayChoice } from "./workerGatewaySetting.ts";
import {
  detectServices,
  ownInstall,
  repairServices,
  serviceAgentd,
  setupAgentd,
} from "./agentdServices.ts";
import { makeClaudeTrust, projectFolder } from "./claudeTrust.ts";
import { makeCloudKeyFile } from "./cloudKeyFile.ts";
import { AGENTD_SKILLS, workerSkillsDirectories } from "./skillCatalog.ts";
import {
  estimateType,
  PROJECT_FILES,
  readDollarBudgets,
  readEstimate,
  readMaxWorkers,
  suggestCheck,
} from "./taskDefaults.ts";
import { joinedPerson, mergeTaskHolders, repositoryTargets } from "./taskOthers.ts";
import { claudeAttachCommand, permissionModeState } from "./permissionMode.ts";

export class AgentdBridge extends Context.Service<
  AgentdBridge,
  {
    readonly status: Effect.Effect<AgentdStatus, AgentdError>;
    readonly subscribeTasks: Stream.Stream<ReadonlyArray<AgentdTaskRow>, AgentdError>;
    readonly task: (input: AgentdTaskInput) => Effect.Effect<AgentdTask, AgentdError>;
    readonly subscribeTaskOutput: (
      input: AgentdTaskInput,
    ) => Stream.Stream<OrchestrationV2CommandOutputFrame, AgentdError>;
    readonly stopTask: (input: AgentdStopTaskInput) => Effect.Effect<{}, AgentdError>;
    /** `handoff recheck`: reruns the task's check; a failed check fails with agentd's output. */
    readonly recheckTask: (input: AgentdTaskInput) => Effect.Effect<{}, AgentdError>;
    readonly startTask: (
      input: AgentdStartTaskInput | AgentdCloudTaskInput,
    ) => Effect.Effect<AgentdStartTaskResult, AgentdError>;
    readonly retryStart: (
      input: AgentdRetryStartInput,
    ) => Effect.Effect<AgentdStartTaskResult, AgentdError>;
    readonly approvals: Effect.Effect<ReadonlyArray<AgentdApproval>, AgentdError>;
    readonly inbox: Effect.Effect<ReadonlyArray<AgentdInboxItem>, AgentdError>;
    readonly people: (input: AgentdPeopleInput) => Effect.Effect<AgentdPeople, AgentdError>;
    readonly connectAgent: (
      input: AgentdConnectAgentInput,
    ) => Effect.Effect<AgentdCommandOutput, AgentdError>;
    readonly joinTeam: (
      input: AgentdJoinTeamInput,
    ) => Effect.Effect<AgentdCommandOutput, AgentdError>;
    readonly cloudSetup: (
      input: AgentdCloudSetupInput,
    ) => Effect.Effect<AgentdCloudSetup, AgentdError>;
    readonly cloudReview: (
      input: AgentdCloudReviewInput,
    ) => Effect.Effect<AgentdCloudReview, AgentdError>;
    /** `agentd cloud setup` with the account key on stdin; the balance it verified. */
    readonly cloudConfigure: (
      input: AgentdCloudConfigureInput,
    ) => Effect.Effect<AgentdCloudConfigured, AgentdError>;
    /** A chosen key file's provider and privacy; with makePrivate, chmod 600 first. */
    readonly cloudKeyFile: (
      input: AgentdCloudKeyFileInput,
      makePrivate: boolean,
    ) => Effect.Effect<AgentdCloudKeyFileCheck, AgentdError>;
    /** Re-registers services on a missing or old agentd with this app's; only on the user's say. */
    readonly repairServices: (
      input: AgentdServicesRepairInput,
    ) => Effect.Effect<AgentdServicesRepairResult, AgentdError>;
    readonly taskDefaults: (
      input: AgentdTaskDefaultsInput,
    ) => Effect.Effect<AgentdTaskDefaults, AgentdError>;
    /** The Git identity a worker's commits in cwd would carry; "" for a part that is unset. */
    readonly gitIdentity: (
      input: AgentdGitIdentityInput,
    ) => Effect.Effect<AgentdGitIdentity, AgentdError>;
    /** `git config --global user.name` and `user.email`, for every repository of this user. */
    readonly setGitIdentity: (input: AgentdSetGitIdentityInput) => Effect.Effect<{}, AgentdError>;
    readonly taskOthers: (
      input: AgentdTaskOthersInput,
    ) => Effect.Effect<ReadonlyArray<AgentdTaskOther>>;
    /** agentd's path, for the team node's long-lived worker. */
    readonly binary: Effect.Effect<string, AgentdError>;
    /** The agentd `init` runs as: one clients can be connected to. */
    readonly setupBinary: Effect.Effect<string, AgentdError>;
    readonly enrolWorker: (server: string, ticket: string) => Effect.Effect<void, AgentdError>;
    readonly foreground: (minutes: number) => Effect.Effect<void, AgentdError>;
    readonly eula: Effect.Effect<AgentdEula, AgentdError>;
    /**
     * Makes a backup of agentd's ledger in `dir`, encrypted to `input.recipient`, and removes the
     * backups made before it there. One at a time: a second waits for the first.
     */
    readonly backupCreate: (
      input: AgentdBackupCreateInput,
      dir: string,
    ) => Effect.Effect<Omit<AgentdBackupCreated, "relativeUrl" | "expiresAt">, AgentdError>;
    readonly workerGateway: Effect.Effect<Omit<AgentdWorkerGateway, "chosen">, AgentdError>;
    /** Null goes back to the tool's own login and default model. */
    readonly setWorkerGateway: (
      tool: AgentdWorkerTool,
      choice: WorkerGatewayChoice | null,
    ) => Effect.Effect<void, AgentdError>;
    /** The worker permission mode as agentd holds it. */
    readonly permissionMode: Effect.Effect<AgentdPermissionModeState, AgentdError>;
    /** Sets it to guarded; the value is fixed, so the app can never raise the mode. */
    readonly lowerPermissionMode: Effect.Effect<AgentdPermissionModeState, AgentdError>;
    readonly setMaxWorkers: (maxWorkers: number) => Effect.Effect<void, AgentdError>;
  }
>()("t3/agentd/AgentdBridge") {}

// agentd's exit status for a command run before `agentd init`.
const NOT_SET_UP_EXIT = 78;
const TASKS_POLL_INTERVAL = Duration.seconds(5);
const OUTPUT_POLL_INTERVAL = Duration.seconds(1);
// Re-read the task this many output polls apart to learn whether its worker still runs.
const OUTPUT_STATE_EVERY = 5;
const OUTPUT_TAIL_BYTES = 64 * 1024;
// agentd reads are host reads a client asks for while it shows them, as diagnostics are.
const POLL_SCOPE = { type: "diagnostics" } as const;
const RUNNING_STATES = new Set(["offered", "claimed"]);
// A cloud job past these has nothing more for `cloud sync` to mirror.
const CLOUD_FINAL_STATES = new Set([
  "completed",
  "failed",
  "failed_verification",
  "budget_exceeded",
  "cancelled",
  "settlement_conflict",
  "expired",
]);
// The watchdog syncs cloud jobs each pass; while one may not run, a shown list syncs this often.
const CLOUD_SYNC_INTERVAL = Duration.seconds(30);

/** A listed cloud job whose state agentd still has to mirror from the Job API. */
function hasOpenCloudJob(rows: ReadonlyArray<AgentdTaskRow>): boolean {
  return rows.some(
    (row) =>
      row.cloudState != null && row.cloudState !== "" && !CLOUD_FINAL_STATES.has(row.cloudState),
  );
}

function sameRows(a: ReadonlyArray<AgentdTaskRow>, b: ReadonlyArray<AgentdTaskRow>): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i]!;
      return (Object.keys(row) as Array<keyof AgentdTaskRow>).every(
        (key) => row[key] === other[key],
      );
    })
  );
}

const GIT_IDENTITY_KEYS = ["user.name", "user.email"] as const;

const commandError = (message: string, notSetUp = false) =>
  new AgentdCommandError({ message, notSetUp });

function decodeJson<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (stdout: string) =>
    decode(stdout).pipe(
      Effect.mapError(() =>
        commandError("LibraOS Engine answered with JSON this app cannot read."),
      ),
    );
}

const decodeDoctor = decodeJson(AgentdDoctorJson);
const decodeList = decodeJson(AgentdHandoffListJson);
const decodeShow = decodeJson(AgentdHandoffShowJson);
const decodeApprovals = decodeJson(AgentdApprovalListJson);
const decodeInbox = decodeJson(AgentdInboxListJson);
const decodeUsers = decodeJson(AgentdUserListJson);
const decodeNodes = decodeJson(Schema.Array(AgentdNode));
const decodeWho = decodeJson(AgentdWhoJson);
const isDefaultWorker = Schema.is(AgentdWorkerTool);
const decodeInstallRecord = Schema.decodeEffect(Schema.fromJsonString(AgentdInstallRecord));

const isArgumentError = Schema.is(AgentdArgumentError);

function args(
  build: () => ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, AgentdError> {
  return Effect.try({
    try: build,
    catch: (error) =>
      commandError(isArgumentError(error) ? error.message : "Invalid LibraOS Engine input."),
  });
}

export const make = Effect.fn("AgentdBridge.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const configuredUser = env.AGENTD_USER?.trim() || null;
  const hostUser = yield* HostProcess.Username;
  const taskViewer = configuredUser ?? (hostUser?.split("\\").at(-1) || null);
  const platform = yield* HostProcess.Platform;
  const skillHost = { platform, home: yield* HostProcess.HomeDirectory, env };

  // Set by the desktop app beside the AGENTD_BIN of the agentd it carries.
  const bundled = env.AGENTD_DESKTOP_BUNDLED === "1" ? { bundled: true } : {};
  // Resolved per call, so an agentd installed after the server started is found.
  const binary = Effect.gen(function* () {
    const configured = env.AGENTD_BIN?.trim() || undefined;
    const found = yield* findEngine(env).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HostProcess.Platform, platform),
    );
    if (found === null) {
      return yield* new AgentdNotFoundError({
        message:
          configured === undefined
            ? "LibraOS Engine (libraos-engine, libraos-core or agentd) was not found on PATH."
            : `LibraOS Engine was not found at AGENTD_BIN (${configured}).`,
        ...bundled,
      });
    }
    return found;
  });

  const run = Effect.fn("AgentdBridge.run")(function* (
    argv: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly jsonOnFailure?: boolean;
      readonly command?: string;
      readonly timeout?: Duration.Input;
    } = {},
  ) {
    const command = options.command ?? (yield* binary);
    const output = yield* runner
      .run({
        command,
        args: argv,
        stdin: options.stdin,
        timeout: options.timeout ?? Duration.seconds(60),
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProcessSpawnError"
            ? new AgentdNotFoundError({
                message: `LibraOS Engine at ${command} could not be started.`,
                ...bundled,
              })
            : commandError(
                error._tag === "ProcessTimeoutError"
                  ? "LibraOS Engine did not answer in time."
                  : "LibraOS Engine could not be read.",
              ),
        ),
      );
    if (output.timedOut) return yield* commandError("LibraOS Engine did not answer in time.");
    const said = (output.stderr || output.stdout).trim();
    if (output.code === NOT_SET_UP_EXIT) {
      return yield* commandError(said || "LibraOS Engine is not set up yet.", true);
    }
    // doctor exits non-zero when a check fails and still prints its whole report.
    if (output.code !== 0 && !options.jsonOnFailure) {
      return yield* commandError(said || `LibraOS Engine exited with ${output.code}.`);
    }
    return output.stdout;
  });

  const backupLock = yield* Semaphore.make(1);

  const cloudKeyFile = makeCloudKeyFile({
    isAbsolute: pathService.isAbsolute,
    platform,
    uid: process.getuid?.(),
  });

  const cloud = yield* makeAgentdCloud({
    binary,
    run,
    runProcess: runner.run,
    isAbsolute: pathService.isAbsolute,
    args,
    platform,
    keyProvider: (path) =>
      cloudKeyFile({ path }, false).pipe(
        Effect.map((check) => check.provider),
        Effect.orElseSucceed(() => null),
      ),
  });

  const readShow = (id: string) =>
    args(() => agentdArgs.show(id)).pipe(
      Effect.flatMap((argv) => run(argv)),
      Effect.flatMap(decodeShow),
    );

  const cloudReview = makeCloudReview({
    runProcess: runner.run,
    readShow,
    originProject: cloud.originProject,
  });

  // The desktop app's last pass installing agentd for the terminal and agents, when it ran one.
  const recordPath = env.AGENTD_DESKTOP_INSTALL_RECORD?.trim();
  const readInstallText = recordPath
    ? fs.readFileString(recordPath).pipe(Effect.orElseSucceed(() => null))
    : Effect.succeed(null);
  const decodeInstallText = (text: string | null) =>
    text === null
      ? Effect.succeed(null)
      : decodeInstallRecord(text).pipe(Effect.orElseSucceed(() => null));
  const readInstallRecord = readInstallText.pipe(Effect.flatMap(decodeInstallText));

  // agentd's services on a missing or old agentd: checked on start and after a Repair, never moved
  // unless the user confirms Repair.
  let servicesProblem: AgentdServicesProblem | null = null;
  // The install pass the last check read: a later pass (a new agentd placed, its services
  // refreshed or not) is checked again.
  let checkedInstall: string | null | undefined;
  const bundledBinary = env.AGENTD_DESKTOP_BUNDLED === "1" ? env.AGENTD_BIN?.trim() : undefined;
  const home = bundledBinary ? yield* HostProcess.HomeDirectory : "";
  const serviceDeps = bundledBinary
    ? readInstallText.pipe(
        Effect.tap((text) =>
          Effect.sync(() => {
            checkedInstall = text;
          }),
        ),
        Effect.flatMap(decodeInstallText),
        Effect.map((installed) => ({
          bundled: bundledBinary,
          target: serviceAgentd(bundledBinary, env.APPDIR, installed),
          platform,
          home,
          root: env.AGENTD_ROOT,
          installed: ownInstall(installed),
          run: runner.run,
        })),
      )
    : null;
  const setupBinary = bundledBinary
    ? readInstallRecord.pipe(
        Effect.map((installed) => setupAgentd(bundledBinary, installed)),
        Effect.flatMap((chosen) =>
          chosen === bundledBinary
            ? binary
            : fs.exists(chosen).pipe(
                Effect.orElseSucceed(() => false),
                Effect.flatMap((there) => (there ? Effect.succeed(chosen) : binary)),
              ),
        ),
      )
    : binary;
  const provideFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
    );
  const checkServices = Effect.fn("AgentdBridge.checkServices")(function* () {
    if (serviceDeps === null) return null;
    const problem = yield* provideFiles(detectServices(yield* serviceDeps));
    servicesProblem = problem;
    if (problem !== null)
      yield* Effect.logWarning("agentd services run a missing or old agentd", problem);
    return problem;
  });
  if (serviceDeps !== null) yield* checkServices().pipe(Effect.ignore, Effect.forkScoped);

  const repairAgentdServices = Effect.fn("AgentdBridge.repairServices")(function* (
    input: AgentdServicesRepairInput,
  ) {
    const problem = serviceDeps === null ? null : yield* checkServices();
    if (serviceDeps === null || problem === null) return { ok: true };
    if (problem.moves.length === 0)
      return yield* commandError(
        "Repair isn’t available for these services. Run libraos-core install in a terminal.",
      );
    const confirmed = new Set(input.moves);
    if (problem.moves.length !== confirmed.size || problem.moves.some((n) => !confirmed.has(n)))
      return yield* commandError(
        "LibraOS Engine’s background services changed since you confirmed Repair. Check what it changes now and confirm again.",
      );
    const installed = yield* provideFiles(repairServices(yield* serviceDeps, problem));
    // A service still on a missing or old agentd, or a watchdog systemd hasn't enabled, after
    // install is no repair.
    const after = yield* checkServices();
    const result = installed.ok && after !== null ? { ...installed, ok: false } : installed;
    if (result.ok) yield* Effect.logInfo("agentd services repaired on request");
    else yield* Effect.logWarning("agentd services repair fell short", { result, after });
    return result;
  });

  // Until the watchdog runs a working agentd, the listed cloud jobs are synced here, never often.
  // One sync at a time, beside the list: a slow Job API never holds up the local tasks.
  const bridgeScope = yield* Scope.Scope;
  let lastCloudSync = 0;
  let syncing = false;
  const syncCloud = Effect.fn("AgentdBridge.syncCloud")(function* (
    rows: ReadonlyArray<AgentdTaskRow>,
  ) {
    if (syncing || !hasOpenCloudJob(rows)) return;
    const now = yield* Clock.currentTimeMillis;
    if (now - lastCloudSync < Duration.toMillis(CLOUD_SYNC_INTERVAL)) return;
    lastCloudSync = now;
    syncing = true;
    yield* run(agentdArgs.cloudSync()).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          syncing = false;
        }),
      ),
      Effect.forkIn(bridgeScope),
    );
  });

  const [readOlderOffers, invalidateOlderOffers] = yield* Effect.cachedInvalidateWithTTL(
    args(() => agentdArgs.listOffered(configuredUser)).pipe(
      Effect.flatMap((argv) => run(argv)),
      Effect.flatMap(decodeList),
      Effect.orElseSucceed(() => []),
    ),
    "30 seconds",
  );

  const readTasks = Effect.gen(function* () {
    const recent = yield* run(agentdArgs.list()).pipe(Effect.flatMap(decodeList));
    if (recent.length < HANDOFF_PAGE_SIZE) return recent.map(AgentdJson.agentdTaskRow);
    const offered = yield* readOlderOffers;
    const recentIds = new Set(recent.map((row) => row.id));
    return [...recent, ...offered.filter((row) => !recentIds.has(row.id))].map(
      AgentdJson.agentdTaskRow,
    );
  });

  const eula: AgentdBridge["Service"]["eula"] = run(agentdArgs.eula()).pipe(
    Effect.map((text) => ({ version: AgentdJson.eulaVersion(text), text })),
    Effect.withSpan("AgentdBridge.eula"),
  );

  const readDoctor = run(agentdArgs.doctor(), { jsonOnFailure: true }).pipe(
    Effect.flatMap(decodeDoctor),
  );

  // Once per agent per server run: a registration left pointing at an agentd that moved (another
  // install folder) is written again by the agentd this server runs. A failed try stays failed.
  const repairTried = new Set<AgentdWorkerTool>();
  const repairStaleRegistrations = Effect.fn("AgentdBridge.repairStaleRegistrations")(function* (
    doctor: AgentdDoctorJson,
  ) {
    if (doctor.set_up === false) return doctor;
    const stale = AgentdJson.staleRegistrations(doctor).filter((tool) => !repairTried.has(tool));
    if (stale.length === 0) return doctor;
    for (const tool of stale) repairTried.add(tool);
    yield* Effect.forEach(
      stale,
      (agent) => run(agentdArgs.connectAgent({ agent, dryRun: false })).pipe(Effect.ignore),
      { discard: true },
    );
    return yield* readDoctor.pipe(Effect.orElseSucceed(() => doctor));
  });

  // agentd's Skills a worker tool cannot find: workers still run, so this only warns.
  const missingSkills = (tool: AgentdWorkerTool) =>
    Effect.filter(AGENTD_SKILLS, (skill) =>
      Effect.map(
        Effect.forEach(workerSkillsDirectories(tool, skillHost), (directory) =>
          fs
            .exists(pathService.join(directory, skill, "SKILL.md"))
            .pipe(Effect.orElseSucceed(() => false)),
        ),
        (found) => !found.includes(true),
      ),
    );

  const status: AgentdBridge["Service"]["status"] = Effect.gen(function* () {
    // A problem shown is read again, so services the user fixed by hand stop showing on Refresh.
    const passChanged = serviceDeps !== null && (yield* readInstallText) !== checkedInstall;
    if (servicesProblem !== null || passChanged) yield* checkServices().pipe(Effect.ignore);
    const [version, doctor] = yield* Effect.all([run(agentdArgs.version()), readDoctor], {
      concurrency: 2,
    }).pipe(
      Effect.flatMap(([version, doctor]) =>
        Effect.map(repairStaleRegistrations(doctor), (d) => [version, d] as const),
      ),
    );
    // Only a saved acceptance needs the carried version, to see whether agentd would ask again.
    const carried =
      typeof AgentdJson.acceptedEula(doctor) === "string"
        ? yield* eula.pipe(
            Effect.map((read) => read.version),
            Effect.orElseSucceed(() => null),
          )
        : null;
    const status = AgentdJson.agentdStatus(version, doctor, carried);
    const [defaultWorker, dollarBudgets, maxWorkers] = status.setUp
      ? yield* Effect.all(
          [
            run(agentdArgs.defaultWorker()).pipe(
              Effect.map((stdout) => {
                const worker = stdout.trim();
                return isDefaultWorker(worker) ? worker : null;
              }),
              Effect.orElseSucceed(() => null),
            ),
            run(agentdArgs.budgetPrices()).pipe(
              Effect.map(readDollarBudgets),
              Effect.orElseSucceed(() => null),
            ),
            run(agentdArgs.maxWorkers()).pipe(
              Effect.map(readMaxWorkers),
              Effect.orElseSucceed(() => null),
            ),
          ],
          { concurrency: 3 },
        )
      : [null, null, null];
    const install = yield* readInstallRecord;
    return {
      ...status,
      defaultWorker,
      dollarBudgets,
      maxWorkers,
      missingSkills: defaultWorker === null ? null : yield* missingSkills(defaultWorker),
      ...(status.setUp ? { cpuCount: NodeOS.availableParallelism() } : {}),
      binary: yield* binary,
      install,
      ...(servicesProblem === null ? {} : { servicesProblem }),
    };
  }).pipe(Effect.withSpan("AgentdBridge.status"));

  // The first read fails the stream; a later failed read keeps the last list until agentd answers.
  const subscribeTasks: AgentdBridge["Service"]["subscribeTasks"] = Stream.paginate(
    null as ReadonlyArray<AgentdTaskRow> | null,
    (previous) =>
      Effect.gen(function* () {
        if (previous === null) {
          const rows = yield* readTasks;
          return [[rows], Option.some(rows)] as const;
        }
        yield* Effect.sleep(TASKS_POLL_INTERVAL);
        if (!(yield* backgroundPolicy.shouldRunScopeWork(POLL_SCOPE))) {
          return [[], Option.some(previous)] as const;
        }
        yield* syncCloud(previous);
        const rows = yield* readTasks.pipe(Effect.option);
        if (Option.isNone(rows) || sameRows(previous, rows.value)) {
          return [[], Option.some(previous)] as const;
        }
        return [[rows.value], Option.some(rows.value)] as const;
      }),
  );

  const readLog = (path: string, from: number, to: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        const bytes = yield* file.readAlloc(to - from, { position: BigInt(from) });
        return Option.getOrElse(bytes, () => new Uint8Array());
      }),
    );

  const logSize = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  const subscribeTaskOutput: AgentdBridge["Service"]["subscribeTaskOutput"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const show = yield* readShow(input.id);
        const log = show.worker_log ?? null;
        if (log === null || log === "") {
          const empty: OrchestrationV2CommandOutputFrame = {
            kind: "replace",
            text: "",
            truncated: false,
            running: false,
          };
          return Stream.succeed(empty);
        }
        let decoder = new TextDecoder();
        let offset: number | null = null;
        let running = RUNNING_STATES.has(show.state);
        let polls = 0;
        const tail = Effect.fn("AgentdBridge.outputTail")(function* (size: number) {
          const from = Math.max(0, size - OUTPUT_TAIL_BYTES);
          decoder = new TextDecoder();
          const bytes = yield* readLog(log, from, size);
          offset = size;
          return {
            kind: "replace",
            text: decoder.decode(bytes, { stream: true }),
            truncated: from > 0,
            running,
          } satisfies OrchestrationV2CommandOutputFrame;
        });
        return Stream.paginate(true, (more: boolean) =>
          Effect.gen(function* () {
            if (!more) return [[], Option.none()] as const;
            if (offset === null) {
              const frame = yield* tail(yield* logSize(log));
              return [[frame], Option.some(running)] as const;
            }
            yield* Effect.sleep(OUTPUT_POLL_INTERVAL);
            polls += 1;
            if (polls % OUTPUT_STATE_EVERY === 0) {
              const state = yield* readShow(input.id).pipe(Effect.option);
              if (Option.isSome(state)) running = RUNNING_STATES.has(state.value.state);
            }
            const size = yield* logSize(log);
            const frames: OrchestrationV2CommandOutputFrame[] = [];
            if (size < offset || size - offset > OUTPUT_TAIL_BYTES) {
              frames.push(yield* tail(size));
            } else if (size > offset || !running) {
              const bytes = yield* readLog(log, offset, size);
              offset = size;
              frames.push({
                kind: "append",
                text: decoder.decode(bytes, { stream: running }),
                truncated: false,
                running,
              });
            }
            return [frames, Option.some(running)] as const;
          }).pipe(Effect.mapError(() => commandError("The task's worker log could not be read."))),
        );
      }),
    );

  const claudeTrust = makeClaudeTrust({
    fs,
    path: pathService,
    env,
    home: yield* HostProcess.HomeDirectory,
  });

  // Claude Code checks the main checkout, also for a worktree, then the folder and its parents.
  const ensureClaudeTrust = Effect.fn("AgentdBridge.ensureClaudeTrust")(function* (
    cwd: string,
    consent: boolean | string,
  ) {
    const commonDir = yield* runner
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
        timeout: Duration.seconds(10),
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
    const folder = projectFolder(cwd, commonDir, pathService);
    if ((yield* claudeTrust.trusted(folder)) || (yield* claudeTrust.trusted(cwd))) return;
    if (consent !== true && consent !== folder)
      return yield* new AgentdCommandError({
        message: `Claude Code hasn’t been allowed to work in ${folder} yet.`,
        notSetUp: false,
        untrustedFolder: folder,
      });
    yield* claudeTrust.trust(folder);
  });

  const listRow = (id: string) =>
    run(agentdArgs.list()).pipe(
      Effect.flatMap(decodeList),
      Effect.map((rows) => rows.find((row) => row.id === id) ?? null),
    );

  // agentd names the open task holding the directory in prose; the app shows it as a choice.
  const refused = Effect.fn("AgentdBridge.refusedDispatch")(function* (id: string, note: string) {
    const refusal = blockingRefusal(note);
    if (refusal === null) return { id, started: false, note };
    // The goal and a fresher running state, when agentd's list still has the task.
    const row = yield* listRow(refusal.id).pipe(Effect.orElseSucceed(() => null));
    const blocking: AgentdBlockingTask = {
      id: refusal.id,
      state: row?.state ?? refusal.state,
      goal: row === null ? null : row.goal || row.title || null,
      running: refusal.running || row?.worker_running === true,
    };
    return { id, started: false, note, blocking };
  });

  // A failed dispatch leaves the task offered in agentd, where Start can run it again.
  const dispatch = Effect.fn("AgentdBridge.dispatch")(function* (
    id: string,
    worker: AgentdWorkerTool,
    force: boolean,
    queuedCwd?: string,
  ) {
    return yield* run(yield* args(() => agentdArgs.dispatch(id, worker, force, queuedCwd))).pipe(
      Effect.as<AgentdStartTaskResult>({ id, started: true, note: null }),
      Effect.catchTags({ AgentdCommandError: (error) => refused(id, error.message) }),
    );
  });

  const startTask = Effect.fn("AgentdBridge.startTask")(function* (
    input: AgentdStartTaskInput | AgentdCloudTaskInput,
  ) {
    if (input.cloud !== undefined) return yield* cloud.startCloudTask(input);
    if (input.worker === "claude")
      yield* ensureClaudeTrust(input.cwd, input.trustClaudeFolder === true);
    const created = yield* run(yield* args(() => agentdArgs.new(input))).pipe(
      Effect.flatMap(
        decodeJson(
          Schema.Struct({
            handoff: Schema.optionalKey(Schema.String),
            id: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    );
    const id = created.handoff ?? created.id;
    if (id === undefined)
      return yield* commandError("LibraOS Engine did not name the task it made.");
    return yield* dispatch(id, input.worker, false);
  });

  const queuedCheckout = Effect.fn("AgentdBridge.queuedCheckout")(function* (
    id: string,
    parked: boolean,
  ) {
    const show = yield* readShow(id);
    const task = AgentdJson.agentdTask(show, taskViewer);
    if (task.parkAction === "unpark") {
      return yield* commandError(
        "Release this task in a LibraOS Engine terminal with handoff unpark.",
      );
    }
    if (task.parkAction === "approval") {
      return yield* commandError("Check the LibraOS Engine Inbox for a command approval.");
    }
    if (
      task.state !== "offered" ||
      show.worker_running ||
      show.claimer ||
      task.workerState ||
      task.budgetState === "stopped" ||
      task.budgetState === "budget_exceeded" ||
      (task.parked !== undefined) !== parked ||
      (!parked &&
        ((show.a2a_state && show.a2a_state !== "submitted") || task.workerTool !== null)) ||
      task.runsOn !== "local" ||
      task.cloud ||
      task.queuePickup === "remote"
    ) {
      return yield* new AgentdCommandError({
        message: "This task is no longer waiting for an agent.",
        notSetUp: false,
        queuedStartRefusal: "no-longer-queued",
      });
    }
    if (task.queuePickup === "recipient") {
      return yield* new AgentdCommandError({
        message: "This task is addressed to a specific session.",
        notSetUp: false,
        queuedStartRefusal: "has-recipient",
      });
    }
    if (task.queueBlock !== undefined) return yield* commandError(task.queueBlock);
    const cwd = AgentdJson.queuedStartFolder(show);
    if (cwd && pathService.isAbsolute(cwd)) {
      const isDirectory = yield* fs.stat(cwd).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isDirectory) return cwd;
    }
    return yield* new AgentdCommandError({
      message: "No local checkout is available for this task.",
      notSetUp: false,
      queuedStartRefusal: "no-checkout",
    });
  });

  const retryStart = Effect.fn("AgentdBridge.retryStart")(function* (input: AgentdRetryStartInput) {
    const resolvingConflict = "blocking" in input;
    const parked = input.action === "parked";
    const cwd =
      !resolvingConflict || input.queued ? yield* queuedCheckout(input.id, parked) : undefined;
    if (cwd !== undefined) {
      const consent = "trustedFolder" in input ? (input.trustedFolder ?? false) : false;
      if (input.worker === "claude") yield* ensureClaudeTrust(cwd, consent);
      yield* run(yield* args(() => agentdArgs.appSession(cwd)));
    }
    if (!resolvingConflict || input.action === "force") {
      return yield* dispatch(input.id, input.worker, input.action !== "queued", cwd).pipe(
        Effect.tap(() => invalidateOlderOffers),
      );
    }
    const row = yield* listRow(input.blocking);
    if (row === null) {
      return yield* commandError(
        `LibraOS Engine could not read task ${input.blocking}, so it was not released.`,
      );
    }
    // Releasing a task whose worker still runs would stop live work the person did not see.
    if (row.worker_running === true) {
      return yield* commandError(
        `Task ${input.blocking} still has a worker running, so it was not released.`,
      );
    }
    // agentd's decline is only for the session an offer is addressed to; a cancel by its sender
    // or an owner releases an offered or claimed task alike.
    if (row.state === "offered" || row.state === "claimed") {
      const reason = `Released from LibraOS Next to start ${input.id}`;
      yield* run(yield* args(() => agentdArgs.cancel(input.blocking, reason)));
    }
    return yield* dispatch(input.id, input.worker, false, cwd);
  });

  const people = Effect.fn("AgentdBridge.people")(function* (input: AgentdPeopleInput) {
    const users = yield* run(agentdArgs.users()).pipe(Effect.flatMap(decodeUsers));
    const target = input.target;
    const holders =
      target === undefined
        ? []
        : AgentdJson.agentdHolders(
            yield* run(yield* args(() => agentdArgs.who(target))).pipe(Effect.flatMap(decodeWho)),
          );
    const nodes = input.includeNodes
      ? yield* run(agentdArgs.nodes()).pipe(
          Effect.flatMap(decodeNodes),
          // agentd v0.1.15+ public builds have no `agentd server`: no node cards, people still list.
          Effect.catchTags({
            AgentdCommandError: (error) =>
              error.message.includes("part of the team server")
                ? Effect.undefined
                : Effect.fail(error),
          }),
        )
      : undefined;
    return {
      people: AgentdJson.agentdPeople(users),
      holders,
      ...(nodes === undefined ? {} : { nodes }),
    };
  });

  const readTaskWho = Effect.fn("AgentdBridge.readTaskWho")(function* (target: string) {
    const who = yield* run(yield* args(() => agentdArgs.who(target))).pipe(
      Effect.flatMap(decodeWho),
    );
    if (!who.server || who.server_note) {
      return yield* commandError("LibraOS Engine could not look up team holdings.");
    }
    return who;
  });

  const taskOthers = Effect.fn("AgentdBridge.taskOthers")(
    function* ({ cwd, issue }: AgentdTaskOthersInput) {
      const doctor = yield* readDoctor;
      const team = joinedPerson(doctor);
      if (doctor.set_up === false || team === null) return [];
      const namedUser = env.AGENTD_USER?.trim();
      const [checkout, onIssue, local] = yield* Effect.all(
        [
          readTaskWho(cwd),
          issue === null ? Effect.succeed(null) : readTaskWho(issue),
          namedUser
            ? Effect.succeed([namedUser])
            : Effect.gen(function* () {
                const username = env.USER?.trim() || (yield* HostProcess.Username);
                const users = yield* run(agentdArgs.users()).pipe(Effect.flatMap(decodeUsers));
                const owner =
                  users.length === 1 && users[0]?.role === "owner" ? users[0].name : null;
                return [username, owner];
              }),
        ],
        { concurrency: "unbounded" },
      );
      const onRepository = yield* Effect.forEach(repositoryTargets(checkout), readTaskWho, {
        concurrency: "unbounded",
      });
      return mergeTaskHolders(
        onIssue === null ? [checkout, ...onRepository] : [onIssue, checkout, ...onRepository],
        {
          local: [team, ...local],
          team,
        },
      );
    },
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => []),
  );

  const projectFile = Effect.fn("AgentdBridge.projectFile")(
    function* (cwd: string, name: string) {
      const file = pathService.join(cwd, name);
      const info = yield* fs.stat(file);
      if (info.type !== "File") return null;
      // Only package.json is read, and only to find its test script.
      if (name !== "package.json") return "";
      return Number(info.size) > 1024 * 1024 ? null : yield* fs.readFileString(file);
    },
    Effect.orElseSucceed(() => null),
  );

  const taskDefaults = Effect.fn("AgentdBridge.taskDefaults")(function* ({
    cwd,
    size,
  }: AgentdTaskDefaultsInput) {
    const type = estimateType(size);
    const [estimate, found] = yield* Effect.all(
      [
        run(agentdArgs.estimate(type)).pipe(
          Effect.map((stdout) => readEstimate(stdout, type)),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => null),
        ),
        pathService.isAbsolute(cwd) && !cwd.includes("\0")
          ? Effect.forEach(PROJECT_FILES, (name) => projectFile(cwd, name), {
              concurrency: "unbounded",
            })
          : Effect.succeed(PROJECT_FILES.map(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const contents = new Map(PROJECT_FILES.map((name, index) => [name, found[index] ?? null]));
    const check = suggestCheck({
      packageJson: contents.get("package.json") ?? null,
      has: (name) => (contents.get(name as (typeof PROJECT_FILES)[number]) ?? null) !== null,
    });
    return { estimate, check };
  });

  // "git" goes through the runner's resolver, which finds git.exe on Windows.
  const git = (argv: ReadonlyArray<string>, cwd?: string) =>
    runner
      .run({ command: "git", args: argv, cwd, timeout: Duration.seconds(10) })
      .pipe(
        Effect.mapError((error) =>
          commandError(
            error._tag === "ProcessTimeoutError"
              ? "Git did not answer in time."
              : "Git could not be run.",
          ),
        ),
      );

  const gitIdentity = Effect.fn("AgentdBridge.gitIdentity")(function* ({
    cwd,
  }: AgentdGitIdentityInput) {
    const [name, email] = yield* Effect.forEach(
      GIT_IDENTITY_KEYS,
      (key) =>
        git(["config", "--get", key], cwd).pipe(
          Effect.flatMap((output) =>
            // `--get` exits 1 when the key is unset anywhere Git looks.
            output.code === 0
              ? Effect.succeed(output.stdout.trim())
              : output.code === 1
                ? Effect.succeed("")
                : Effect.fail(
                    commandError(output.stderr.trim() || "Git could not read its config."),
                  ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return { name: name ?? "", email: email ?? "" };
  });

  const setGitIdentity = Effect.fn("AgentdBridge.setGitIdentity")(function* (
    input: AgentdSetGitIdentityInput,
  ) {
    for (const [key, value] of [
      ["user.name", input.name.trim()],
      ["user.email", input.email.trim()],
    ] as const) {
      const output = yield* git(["config", "--global", "--", key, value]);
      if (output.code !== 0)
        return yield* commandError(output.stderr.trim() || "Git could not save its config.");
    }
    return {};
  });

  const permissionMode = Effect.gen(function* () {
    const read = (key: Parameters<typeof agentdArgs.configGet>[0]) =>
      run(agentdArgs.configGet(key)).pipe(
        Effect.map((stdout): string | null => stdout),
        // An agentd from before the setting answers "setting is not exposed".
        Effect.catchTags({
          AgentdCommandError: (error) =>
            error.notSetUp ? Effect.fail(error) : Effect.succeed(null),
        }),
      );
    const [global, roles, repos] = yield* Effect.all(
      [
        read("dispatch.permission_mode"),
        read("dispatch.permission_mode_roles"),
        read("dispatch.permission_mode_repos"),
      ],
      { concurrency: 3 },
    );
    return permissionModeState(global, roles, repos);
  }).pipe(Effect.withSpan("AgentdBridge.permissionMode"));

  return AgentdBridge.of({
    status,
    subscribeTasks,
    task: Effect.fn("AgentdBridge.task")(function* (input) {
      const show = yield* readShow(input.id);
      const task = AgentdJson.agentdTask(show, taskViewer);
      const log = show.worker_log ?? "";
      const cwd = AgentdJson.queuedStartFolder(show);
      const details =
        task.state === "offered" && cwd && pathService.isAbsolute(cwd)
          ? { ...task, startFolder: cwd }
          : task;
      if (task.workerState !== "blocked" || task.workerTool !== "claude") return details;
      const head =
        log === ""
          ? ""
          : yield* logSize(log).pipe(
              Effect.flatMap((size) => readLog(log, 0, Math.min(size, OUTPUT_TAIL_BYTES))),
              Effect.map((bytes) => new TextDecoder().decode(bytes)),
              Effect.orElseSucceed(() => ""),
            );
      return { ...details, attachCommand: claudeAttachCommand(head) };
    }),
    subscribeTaskOutput,
    stopTask: Effect.fn("AgentdBridge.stopTask")(function* (input) {
      yield* run(yield* args(() => agentdArgs.cancel(input.id, input.reason)));
      yield* invalidateOlderOffers;
      return {};
    }),
    // The check runs within this call, up to its own limit (10 minutes unless the task sets one).
    recheckTask: Effect.fn("AgentdBridge.recheckTask")(function* (input) {
      yield* run(yield* args(() => agentdArgs.recheck(input.id)), {
        timeout: Duration.minutes(60),
      });
      return {};
    }),
    startTask,
    retryStart,
    approvals: run(agentdArgs.approvals()).pipe(
      Effect.flatMap(decodeApprovals),
      Effect.map(AgentdJson.agentdApprovals),
      Effect.withSpan("AgentdBridge.approvals"),
    ),
    inbox: run(agentdArgs.inbox()).pipe(
      Effect.flatMap(decodeInbox),
      Effect.map(AgentdJson.agentdInbox),
      Effect.withSpan("AgentdBridge.inbox"),
    ),
    people,
    connectAgent: Effect.fn("AgentdBridge.connectAgent")(function* (input) {
      return { output: (yield* run(agentdArgs.connectAgent(input))).trim() };
    }),
    // The ticket goes on stdin only: agentd refuses it as an argument, and spans never record it.
    joinTeam: Effect.fn("AgentdBridge.joinTeam")(function* (input) {
      const argv = yield* args(() => agentdArgs.joinTeam(input.server));
      const ticket = yield* args(() => [agentdTicket(input.ticket)]);
      return { output: (yield* run(argv, { stdin: `${ticket[0]}\n` })).trim() };
    }),
    cloudSetup: cloud.cloudSetup,
    cloudReview,
    cloudConfigure: cloud.cloudConfigure,
    cloudKeyFile,
    repairServices: repairAgentdServices,
    taskDefaults,
    gitIdentity,
    setGitIdentity,
    taskOthers,
    binary,
    setupBinary,
    enrolWorker: Effect.fn("AgentdBridge.enrolWorker")(function* (server, ticket) {
      const argv = yield* args(() => agentdArgs.enrolWorker(server));
      const checked = yield* args(() => [agentdTicket(ticket)]);
      yield* run(argv, { stdin: `${checked[0]}\n` });
    }),
    foreground: Effect.fn("AgentdBridge.foreground")(function* (minutes) {
      yield* run(agentdArgs.foreground(minutes));
    }),
    eula,
    backupCreate: Effect.fn("AgentdBridge.backupCreate")(function* (input, dir) {
      return yield* backupLock.withPermits(1)(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const fileName = agentdBackupFileName(nowMs, crypto.getRandomValues(new Uint8Array(4)));
          const output = pathService.join(dir, fileName);
          const argv = yield* args(() => agentdArgs.backupCreate(output, input.recipient));
          yield* fs
            .makeDirectory(dir, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError(() => commandError("The backups folder could not be made.")));
          const before = yield* fs
            .readDirectory(dir)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          // A ledger of a few hundred megabytes takes minutes to copy, compress and encrypt.
          const answer = yield* run(argv, { timeout: Duration.minutes(15) });
          const made = yield* decodeBackupCreated(answer).pipe(
            Effect.mapError(() =>
              commandError("LibraOS Engine's answer to backup create could not be read."),
            ),
          );
          yield* Effect.forEach(
            before.filter((name) => AGENTD_BACKUP_FILE.test(name) && name !== fileName),
            (name) => fs.remove(pathService.join(dir, name)).pipe(Effect.ignore),
            { discard: true },
          );
          return { fileName, bytes: made.size, sha256: made.sha256, created: made.created };
        }),
      );
    }),
    workerGateway: Effect.gen(function* () {
      const read = (argv: ReadonlyArray<string>) =>
        run(argv).pipe(
          Effect.map((stdout) => stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
      const [help, claude, codex, opencode] = yield* Effect.all(
        [
          read(agentdArgs.configHelp()),
          read(agentdArgs.workerModel("claude")),
          read(agentdArgs.workerModel("codex")),
          read(agentdArgs.workerModel("opencode")),
        ],
        { concurrency: 4 },
      );
      return {
        supported: help.includes("dispatch.claude_base_url"),
        models: { claude, codex, opencode },
      };
    }).pipe(Effect.withSpan("AgentdBridge.workerGateway")),
    setWorkerGateway: Effect.fn("AgentdBridge.setWorkerGateway")(function* (tool, choice) {
      const gateway = yield* args(() =>
        agentdArgs.setWorkerGateway(tool, choice?.url ?? "", choice?.keyFile ?? null),
      );
      const model = yield* args(() => agentdArgs.setWorkerModel(tool, choice?.model ?? ""));
      yield* run(gateway);
      yield* run(model);
    }),
    permissionMode,
    lowerPermissionMode: run(agentdArgs.lowerPermissionMode()).pipe(
      Effect.andThen(permissionMode),
      Effect.withSpan("AgentdBridge.lowerPermissionMode"),
    ),
    setMaxWorkers: Effect.fn("AgentdBridge.setMaxWorkers")(function* (maxWorkers) {
      yield* run(agentdArgs.setMaxWorkers(maxWorkers));
    }),
  });
});

const decodeBackupCreated = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      size: Schema.Number,
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      created: Schema.String,
    }),
  ),
);

export const layer = Layer.effect(AgentdBridge, make());
