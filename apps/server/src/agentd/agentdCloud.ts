import {
  AgentdCloudBudget,
  AgentdCloudKeyFile,
  AgentdCommandError,
  type AgentdCloudConfigureInput,
  type AgentdCloudConfigured,
  type AgentdCloudPlanState,
  type AgentdCloudPlanUsage,
  type AgentdCloudSetup,
  type AgentdCloudSubscription,
  type AgentdCloudSetupInput,
  type AgentdCloudTaskInput,
  type AgentdError,
  type AgentdStartTaskResult,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { ProcessRunner } from "../processRunner.ts";
import {
  currentReservation,
  foundHandoffs,
  newAttempt,
  nextSubmissionId,
  type Reservation,
  submissionFingerprint,
  stateDraft,
  submissionSession,
} from "./agentdCloudSubmissions.ts";
import { agentdArgs } from "./agentdCommands.ts";
import {
  CLOUD_REASONS,
  cloudFailureReason,
  cloudReason,
  cloudSetupProblem,
  cloudSetupReason,
  openKeyFile,
  refusedBeforeTask,
} from "./cloudFailure.ts";

const isCloudTask = Schema.is(AgentdCloudBudget);
const isKeyFile = Schema.is(AgentdCloudKeyFile);
const balanceJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const balanceDetails = Schema.decodeUnknownOption(
  Schema.Struct({
    available_usd: Schema.optionalKey(Schema.Unknown),
    balance_usd: Schema.optionalKey(Schema.Unknown),
    default_budget: Schema.optionalKey(Schema.Unknown),
    plan: Schema.optionalKey(Schema.Unknown),
  }),
);
const planDetails = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.optionalKey(Schema.Unknown),
    worker_minutes_included: Schema.optionalKey(Schema.Unknown),
    worker_minutes_used: Schema.optionalKey(Schema.Unknown),
    worker_minutes_reserved: Schema.optionalKey(Schema.Unknown),
    worker_minutes_left: Schema.optionalKey(Schema.Unknown),
    month_ends_at: Schema.optionalKey(Schema.Unknown),
  }),
);
const offerReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      handoff: Schema.String,
      cloud: Schema.optionalKey(
        Schema.Struct({
          state: Schema.String,
          error: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

const configuredResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      balance: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            available_usd: Schema.optionalKey(Schema.Unknown),
            balance_usd: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      ),
    }),
  ),
);
const planJson = Schema.Struct({
  configured: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  valid: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  expires_about: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
// `agentd cloud subscription --json`: each plan under providers.
const subscriptionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      providers: Schema.Struct({
        claude: Schema.optionalKey(Schema.NullOr(planJson)),
        codex: Schema.optionalKey(Schema.NullOr(planJson)),
      }),
    }),
  ),
);
const setupTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);
const configJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;
const UPGRADE_SUBSCRIPTION =
  "This version of AgentD can’t run Cloud Workers on your own subscription. Run agentd upgrade, then try again.";
const UPGRADE_CHATGPT =
  "This version of AgentD can’t run Codex on your ChatGPT plan. Run agentd upgrade, then try again.";
const UPGRADE_SETUP =
  "This version of AgentD can’t set up Cloud Workers. Run agentd upgrade, then try again.";

interface CloudFeatures {
  readonly cloud: boolean;
  /** `--model-access subscription` (v0.1.14+), named by its `--claude-token-file`. */
  readonly subscription: boolean;
  /** Codex on a ChatGPT plan. */
  readonly codex: boolean;
}

/** A `config get KEY --json` answer as text; null when unset. */
function configText(stdout: string): string | null {
  const parsed = configJson(stdout);
  const value = parsed._tag === "Some" ? parsed.value : stdout;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function usdAmount(value: unknown): number | null {
  const usd = typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
}

function minutes(value: unknown): number | null {
  const amount = usdAmount(value);
  return amount !== null && amount >= 0 ? amount : null;
}

/** A plan account's `plan` object; null for an account without one or one that isn't an object. */
function planUsage(value: unknown): AgentdCloudPlanUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const decoded = planDetails(value);
  if (decoded._tag === "None") return null;
  const plan = decoded.value;
  const ends = plan.month_ends_at;
  const name = typeof plan.name === "string" && plan.name.trim() !== "" ? plan.name.trim() : null;
  return {
    name,
    includedMinutes: minutes(plan.worker_minutes_included),
    usedMinutes: minutes(plan.worker_minutes_used),
    reservedMinutes: minutes(plan.worker_minutes_reserved),
    leftMinutes: minutes(plan.worker_minutes_left),
    monthEndsAt: typeof ends === "string" && !Number.isNaN(Date.parse(ends)) ? ends : null,
  };
}

/** `today` is YYYY-MM-DD: an expiry before it is not valid, whatever else agentd said. */
function planState(
  supported: boolean,
  plan: typeof planJson.Type | null | undefined,
  today: string,
): AgentdCloudPlanState {
  const configured = plan?.configured === true;
  const date = plan?.expires_about ?? null;
  const expiresAbout = configured && date !== null && EXPIRY.test(date) ? date : null;
  return {
    supported,
    configured,
    valid: !configured
      ? null
      : expiresAbout !== null && expiresAbout < today
        ? false
        : (plan?.valid ?? null),
    expiresAbout,
  };
}

const emptySetup = {
  project: null,
  balanceUsd: null,
  balanceText: null,
  defaultBudget: null,
  problem: null,
};
const REPLACE_UNCONFIRMED =
  "AgentD hasn’t confirmed your last cloud submission for this project, and it may still start. Replace it with this one? If it started, this one isn’t sent.";
const originError = "Cloud Workers require a GitHub repository as the checkout’s origin.";
const UNKNOWN_OUTCOME =
  "AgentD may have created this cloud task. Check Background tasks. Start checks whether AgentD recorded it before submitting again.";
const CLOSED_STATES = new Set(["cancelled", "declined", "done", "expired"]);
const GITHUB_ORIGIN =
  /^(?:https?:\/\/(?:[^/@\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:git\+)?ssh:\/\/(?:git@)?(?:ssh\.)?github\.com(?::\d+)?\/|git@github\.com:\/?)(\S+)$/i;
export const GITHUB_PROJECT = /^[a-z\d][a-z\d-]{0,38}\/(?!-|\.{1,2}$)[\w.-]{1,100}$/i;

const submissionShow = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      cloud_state: Schema.optionalKey(Schema.NullOr(Schema.String)),
      body: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ state: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
);

/** OWNER/REPO of a GitHub origin in any form git accepts for github.com; null for any other host. */
function githubProject(origin: string): string | null {
  const path = GITHUB_ORIGIN.exec(origin.trim())?.[1]
    ?.replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return path !== undefined && GITHUB_PROJECT.test(path) ? path.toLowerCase() : null;
}

function cloudProblem(message: string): NonNullable<AgentdCloudSetup["problem"]> {
  return cloudSetupProblem(message) ?? "balance";
}

function commandError(message: string, notSetUp = false) {
  return new AgentdCommandError({ message, notSetUp });
}

function offerError(message: string, notSetUp = false): AgentdCommandError {
  if (notSetUp) return commandError(CLOUD_REASONS.setup, true);
  const problem = cloudSetupProblem(message);
  return commandError(cloudReason(message) ?? CLOUD_REASONS.submit, problem === "setup");
}

const unknownOutcome = (message = UNKNOWN_OUTCOME) =>
  new AgentdCommandError({ message, notSetUp: false, outcomeUnknown: true });

/** A cloud job's one-line reason: why it failed, or a setup problem agentd is still waiting on. */
export function cloudJobNote(
  state: string | null,
  messages: ReadonlyArray<string | null | undefined>,
): string | null {
  const failure = state === null ? null : cloudFailureReason(state, messages);
  if (failure !== null) return failure;
  for (const message of messages) {
    const problem = message ? cloudSetupProblem(message) : null;
    if (problem !== null) return CLOUD_REASONS[problem];
  }
  return null;
}

function readBalance(stdout: string) {
  const parsed = balanceJson(stdout);
  if (parsed._tag === "None") return { ...emptySetup, balanceText: stdout.trim() || null };
  const details = balanceDetails(parsed.value);
  const balanceUsd = usdAmount(
    details._tag === "Some" ? (details.value.available_usd ?? details.value.balance_usd) : null,
  );
  return {
    ...emptySetup,
    balanceUsd,
    plan: details._tag === "Some" ? planUsage(details.value.plan) : null,
    defaultBudget:
      details._tag === "Some" && isCloudTask(details.value.default_budget)
        ? details.value.default_budget
        : null,
  };
}

export const makeAgentdCloud = Effect.fn("AgentdCloud.make")(function* (deps: {
  readonly binary: Effect.Effect<string, AgentdError>;
  readonly run: (
    argv: ReadonlyArray<string>,
    options?: {
      readonly command?: string;
      readonly jsonOnFailure?: boolean;
      readonly stdin?: string;
    },
  ) => Effect.Effect<string, AgentdError>;
  readonly runProcess: ProcessRunner["Service"]["run"];
  readonly isAbsolute: (path: string) => boolean;
  readonly args: (
    build: () => ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, AgentdError>;
  readonly platform: string;
  /** Whose key a file on this host holds; null when it can't be read or told. */
  readonly keyProvider: (path: string) => Effect.Effect<"anthropic" | "openai" | null>;
}) {
  const { binary, run, runProcess, isAbsolute, args, platform, keyProvider } = deps;
  // A second Start for a project waits on agentd's answer to the first, in this server too.
  const inFlight = new Set<string>();
  const capabilities = yield* Cache.makeWith(
    ([command]: readonly [string, string]) =>
      run(agentdArgs.cloudHelp(), { command, jsonOnFailure: true }).pipe(
        // A crashed or cut-off probe prints no usage: that is no answer, never "no cloud", and the
        // cache keeps only answers.
        Effect.filterOrFail(
          (help) => /usage/i.test(help),
          () => commandError("agentd did not answer the Cloud Workers probe."),
        ),
        Effect.map((help): CloudFeatures => ({
          cloud: /(?:^|[\s[|])--cloud(?=[\s\]|=,]|$)/u.test(help),
          subscription: /--claude-token-file\b/.test(help),
          codex: /--codex-auth-file\b/.test(help),
        })),
      ),
    { capacity: 16, timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0) },
  );
  // `cloud setup` (v0.1.15) is listed in `agentd help cloud`; an agentd without it fails or omits it.
  const setupCommand = yield* Cache.makeWith(
    ([command]: readonly [string, string]) =>
      run(agentdArgs.cloudCommands(), { command, jsonOnFailure: true }).pipe(
        Effect.map((help) => /(?:^|[\s|])setup \[[^\n]*--key-file\b/u.test(help)),
        Effect.orElseSucceed(() => false),
      ),
    { capacity: 16, timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0) },
  );
  const cloudAgentd = Effect.gen(function* () {
    const command = yield* binary;
    const version = (yield* run(agentdArgs.version(), { command })).trim();
    const features = yield* Cache.get(capabilities, [command, version]);
    return features.cloud ? { command, version, features } : null;
  });

  const configured = (command: string, key: Parameters<typeof agentdArgs.configGet>[0]) =>
    run(agentdArgs.configGet(key), { command }).pipe(
      Effect.map(configText),
      Effect.orElseSucceed(() => null),
    );

  // Each plan's credential as agentd reports it: its report, else the config keys.
  const readSubscription = Effect.fn("AgentdCloud.subscription")(function* (
    command: string,
    features: CloudFeatures,
  ) {
    const setupUnavailable = platform === "win32";
    const today = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    if (features.codex) {
      const report = yield* run(agentdArgs.cloudSubscription(), { command }).pipe(
        Effect.map(subscriptionJson),
        Effect.orElseSucceed(() => null),
      );
      if (report?._tag === "Some") {
        return {
          claude: planState(true, report.value.providers.claude, today),
          codex: planState(true, report.value.providers.codex, today),
          setupUnavailable,
        } satisfies AgentdCloudSubscription;
      }
    }
    const [claudeFile, expires, codexFile] = yield* Effect.all(
      [
        configured(command, "cloud.claude_token_file"),
        configured(command, "cloud.claude_token_expires_about"),
        features.codex ? configured(command, "cloud.codex_auth_file") : Effect.succeed(null),
      ],
      { concurrency: 3 },
    );
    return {
      // Older agentd dates any nonempty file without checking it holds a setup-token: an estimate.
      claude: planState(
        true,
        { configured: claudeFile !== null, valid: null, expires_about: expires },
        today,
      ),
      codex: planState(features.codex, { configured: codexFile !== null, valid: null }, today),
      setupUnavailable,
    } satisfies AgentdCloudSubscription;
  });

  // Where `cloud setup` would send a key: [cloud] url, else LibraOS. Null when agentd won't say.
  const setupDestination = (command: string) =>
    run(agentdArgs.cloudSetupTarget(), { command }).pipe(
      Effect.map((stdout) => {
        const target = setupTarget(stdout);
        return target._tag === "Some" ? target.value.url : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // Undefined when git didn't say whether there is an origin (timed out, couldn't start, or failed
  // reading the checkout's config): the origin is unknown. Only "no such remote" (exit 2) and "not a
  // git repository" are answers; LC_ALL=C keeps the latter in git's own words.
  const readOrigin = Effect.fn("AgentdCloud.readOrigin")(function* (cwd: string) {
    if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
    const result = yield* runProcess({
      command: "git",
      args: ["remote", "get-url", "--", "origin"],
      cwd,
      env: { LC_ALL: "C" },
      timeout: "5 seconds",
      maxOutputBytes: 4096,
    }).pipe(Effect.option);
    if (result._tag === "None") return undefined;
    const { code, stdout, stderr } = result.value;
    if (code === 0) return githubProject(stdout);
    if (code === 2 || /not a git repository/i.test(stderr)) return null;
    return undefined;
  });
  const originProject = (cwd: string) =>
    readOrigin(cwd).pipe(Effect.map((project) => project ?? null));

  const cloudSetup = Effect.fn("AgentdCloud.setup")(function* ({
    cwd,
    includeBalance,
  }: AgentdCloudSetupInput) {
    const probed = yield* cloudAgentd.pipe(Effect.timeout("20 seconds"), Effect.result);
    // Only an agentd that answered without cloud lacks it; one that didn't answer may have it.
    if (probed._tag === "Failure") return { ...emptySetup, supported: true, unreachable: true };
    const found = probed.success;
    if (found === null) return { ...emptySetup, supported: false };
    const { command, version, features } = found;
    const origin = cwd === null ? null : yield* readOrigin(cwd);
    const project = origin ?? null;
    const canConfigure = yield* Cache.get(setupCommand, [command, version]);
    const base = {
      supported: true,
      canConfigure,
      setupUrl: canConfigure ? yield* setupDestination(command) : null,
      subscription: null,
    };
    if (origin === undefined) return { ...emptySetup, ...base, checkoutUnknown: true };
    if ((cwd !== null && project === null) || !includeBalance)
      return { ...emptySetup, ...base, project };
    const readAccount = run(agentdArgs.cloudBalance(), { command }).pipe(
      Effect.map(readBalance),
      Effect.catchTags({
        AgentdCommandError: (error) =>
          Effect.succeed({
            ...emptySetup,
            problem: error.notSetUp ? ("setup" as const) : cloudProblem(error.message),
          }),
      }),
    );
    const [balance, subscription] = yield* Effect.all(
      [
        readAccount,
        features.subscription
          ? readSubscription(command, features)
          : Effect.succeed<AgentdCloudSubscription | null>(null),
      ],
      { concurrency: 2 },
    );
    return { ...balance, ...base, project, subscription } satisfies AgentdCloudSetup;
  });

  const cloudConfigure = Effect.fn("AgentdCloud.configure")(function* ({
    key,
    url,
  }: AgentdCloudConfigureInput) {
    const secret = key.trim();
    if (secret === "" || /[\r\n\0]/.test(secret))
      return yield* commandError("Paste the account key on one line.");
    const found = yield* cloudAgentd;
    if (found === null || !(yield* Cache.get(setupCommand, [found.command, found.version])))
      return yield* commandError(UPGRADE_SETUP);
    // agentd never prints the key; the reason is scrubbed of it all the same.
    const scrub = (message: string) => message.split(secret).join("[redacted]");
    const argv = yield* args(() => agentdArgs.cloudConfigure(url));
    const stdout = yield* run(argv, {
      command: found.command,
      stdin: `${secret}\n`,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "AgentdCommandError"
          ? commandError(scrub(cloudSetupReason(error.message)), error.notSetUp)
          : error,
      ),
    );
    const result = configuredResult(stdout);
    const balance = result._tag === "Some" ? result.value.balance : null;
    return {
      balanceUsd: usdAmount(balance?.available_usd ?? balance?.balance_usd),
    } satisfies AgentdCloudConfigured;
  });

  // The chosen plan's configured file, always named: with no flag agentd runs on whichever plan
  // is set up, which may not be the one chosen.
  const boundPlan = Effect.fn("AgentdCloud.boundPlan")(function* (
    command: string,
    input: AgentdCloudTaskInput,
  ) {
    const codex = input.cloud.plan === "codex";
    const file = yield* run(
      agentdArgs.configGet(codex ? "cloud.codex_auth_file" : "cloud.claude_token_file"),
      { command },
    ).pipe(
      Effect.map(configText),
      Effect.mapError(() =>
        commandError(
          codex
            ? "AgentD couldn’t read which ChatGPT sign-in is set up, so nothing was submitted. Try again."
            : "AgentD couldn’t read which Claude token is set up, so nothing was submitted. Try again.",
        ),
      ),
    );
    if (file === null || !isKeyFile(file) || !isAbsolute(file))
      return yield* commandError(
        codex ? CLOUD_REASONS.chatgptAuth : CLOUD_REASONS.subscriptionToken,
      );
    return {
      ...input,
      cloud: { ...input.cloud, ...(codex ? { codexAuthFile: file } : { claudeTokenFile: file }) },
    };
  });

  const startCloudTask = Effect.fn("AgentdCloud.startTask")(function* (
    input: AgentdCloudTaskInput,
  ) {
    if (!isCloudTask(input.cloud.budget))
      return yield* commandError("Enter a positive dollar cap for this cloud task.");
    const subscribed = input.cloud.modelAccess === "subscription";
    const planFile =
      input.cloud.plan === "codex" ? input.cloud.codexAuthFile : input.cloud.claudeTokenFile;
    if (subscribed && input.cloud.plan === undefined)
      return yield* commandError("Choose the plan this cloud task runs on.");
    if (subscribed && planFile !== undefined && !(isKeyFile(planFile) && isAbsolute(planFile)))
      return yield* commandError(
        "Enter the absolute path of the credential file on the selected machine.",
      );
    if (input.cloud.modelAccess === "byok") {
      const files = [input.cloud.anthropicKeyFile, input.cloud.openaiKeyFile].filter(
        (file) => file !== undefined,
      );
      if (files.length === 0 || !files.every((file) => isKeyFile(file) && isAbsolute(file))) {
        return yield* commandError(
          "Enter at least one absolute provider key-file path on the selected machine.",
        );
      }
      // agentd reads either field's file as a key, so a swapped file fails only on the worker.
      // Checked here too, for callers that can't read files: only a recognised other provider's
      // key is refused, and an unreadable file stays agentd's to report.
      const fields = [
        ["anthropic", input.cloud.anthropicKeyFile],
        ["openai", input.cloud.openaiKeyFile],
      ] as const;
      for (const [field, file] of fields) {
        if (file === undefined) continue;
        const holds = yield* keyProvider(file);
        if (holds !== null && holds !== field)
          return yield* new AgentdCommandError({
            message:
              field === "openai"
                ? "The file in the OpenAI key field holds an Anthropic key, so nothing was submitted. Put each key file in its own provider’s field."
                : "The file in the Anthropic key field holds an OpenAI key, so nothing was submitted. Put each key file in its own provider’s field.",
            notSetUp: false,
            wrongKeyFile: field,
          });
      }
    }
    const found = yield* cloudAgentd;
    if (found === null)
      return yield* commandError("This version of AgentD does not support Cloud Workers.");
    const { command, features } = found;
    if (subscribed && !features.subscription) return yield* commandError(UPGRADE_SUBSCRIPTION);
    if (subscribed && input.cloud.plan === "codex" && !features.codex)
      return yield* commandError(UPGRADE_CHATGPT);
    const resolved =
      subscribed && planFile === undefined ? yield* boundPlan(command, input) : input;
    const project = yield* originProject(input.cwd);
    if (project === null) return yield* commandError(originError);
    if (inFlight.has(project))
      return yield* commandError(
        `A Cloud Workers submission for ${project} is in progress. Wait for it before starting another.`,
      );
    inFlight.add(project);
    return yield* submitCloudTask(command, project, resolved).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(project))),
    );
  });

  const submitCloudTask = Effect.fn("AgentdCloud.submit")(function* (
    command: string,
    project: string,
    input: AgentdCloudTaskInput,
  ) {
    const session = submissionSession(project);
    const fingerprint = submissionFingerprint(input, project);
    const agentd = (build: () => ReadonlyArray<string>) =>
      args(build).pipe(Effect.flatMap((argv) => run(argv, { command })));
    const reservation = agentd(() => agentdArgs.submissionPins(session)).pipe(
      Effect.map((stdout) => currentReservation(stdout, session)),
      Effect.filterOrFail(
        (current): current is Reservation | null => current !== undefined,
        () => unknownOutcome(),
      ),
      Effect.mapError(() =>
        unknownOutcome(
          "AgentD couldn’t check this project’s earlier Cloud Workers submission, so nothing was submitted. Try again.",
        ),
      ),
    );
    // The task agentd recorded for a submission and the draft that made it (null for an older
    // version's, which names none); null when it has none.
    const recorded = (id: string) =>
      agentd(() => agentdArgs.findSubmission(id)).pipe(
        Effect.map(foundHandoffs),
        Effect.flatMap((hits) =>
          hits === undefined || hits.length > 1
            ? Effect.fail(unknownOutcome())
            : Effect.forEach(hits, (hit) =>
                agentd(() => agentdArgs.show(hit)).pipe(Effect.map(submissionShow)),
              ),
        ),
        Effect.flatMap((shows) => {
          const show = shows[0];
          if (show === undefined) return Effect.succeed(null);
          const draft = show._tag === "Some" ? stateDraft(show.value.body?.state, id) : undefined;
          return show._tag === "Some" && draft !== undefined
            ? Effect.succeed({ handoff: show.value.id, draft })
            : Effect.fail(unknownOutcome());
        }),
        Effect.mapError(() => unknownOutcome()),
      );
    // agentd refused the offer before making a task, so the next Start need not ask before reusing
    // its key. The key itself is never given up: another server sharing this ledger may be offering
    // under it right now, and only one key per reservation keeps that to one paid job.
    const release = (id: string, attempt: string) =>
      agentd(() => agentdArgs.releaseSubmission(session, id, attempt)).pipe(Effect.ignore);
    const remember = (id: string, handoff: string) =>
      agentd(() => agentdArgs.rememberSubmission(session, id, handoff)).pipe(Effect.ignore);
    // A different draft than the one recorded is not sent: that task is the earlier submission's.
    const alreadyRecorded = (handoff: string, earlier: boolean): AgentdStartTaskResult =>
      earlier
        ? {
            id: handoff,
            started: false,
            earlier: true,
            note: `AgentD already recorded your earlier Cloud Workers submission for this project as task ${handoff}, so this one wasn’t sent. See it in Background tasks before starting again.`,
          }
        : {
            id: handoff,
            started: false,
            note: `AgentD already recorded this Cloud Workers submission as task ${handoff}. See it in Background tasks before starting again.`,
          };

    const current = yield* reservation;
    let submission: string;
    // An offer under an earlier reservation's key, whose task may be an earlier draft's.
    let reused = false;
    // This offer, which a refusal releases: never an earlier or later one under the same key.
    const attempt = newAttempt();
    if (current !== null && current.handoff === null) {
      const found = yield* recorded(current.id);
      if (found !== null) {
        yield* remember(current.id, found.handoff);
        return alreadyRecorded(found.handoff, (found.draft ?? current.fingerprint) !== fingerprint);
      }
      if (
        !current.released &&
        current.fingerprint !== fingerprint &&
        input.cloud.replaceSubmission !== current.id
      ) {
        return yield* new AgentdCommandError({
          message: REPLACE_UNCONFIRMED,
          notSetUp: false,
          replaceSubmission: current.id,
        });
      }
      // The same key again: agentd's --idem makes this the earlier offer, never a second one; a
      // different draft under it is refused once the earlier one made a task, and found above.
      submission = current.id;
      reused = true;
      // Recorded first, so a lost answer for this offer, even a retry of the same draft, asks the
      // next different one to replace it.
      yield* agentd(() =>
        agentdArgs.attemptSubmission(session, submission, fingerprint, attempt),
      ).pipe(
        Effect.mapError(() =>
          commandError(
            "AgentD couldn’t reserve this Cloud Workers submission, so nothing was submitted.",
          ),
        ),
      );
    } else {
      if (current !== null && current.handoff !== null) {
        const holder = current.handoff;
        const show = yield* agentd(() => agentdArgs.show(holder)).pipe(
          Effect.map(submissionShow),
          Effect.mapError(() => unknownOutcome()),
        );
        if (show._tag === "None") return yield* unknownOutcome();
        if (show.value.cloud_state === "submitting" && !CLOSED_STATES.has(show.value.state)) {
          return yield* commandError(
            `Task ${holder} for ${project} is still being submitted to Cloud Workers. Wait for it, or stop it in Background tasks, before starting another.`,
          );
        }
      }
      submission = nextSubmissionId(session, current?.id ?? null);
      yield* agentd(() =>
        agentdArgs.reserveSubmission(
          session,
          submission,
          current?.id ?? null,
          fingerprint,
          attempt,
        ),
      ).pipe(
        Effect.mapError(() =>
          commandError(
            "AgentD couldn’t reserve this Cloud Workers submission, so nothing was submitted.",
          ),
        ),
      );
      const saved = yield* reservation;
      if (saved?.id !== submission || saved.fingerprint !== fingerprint) {
        // This window offers nothing, so its reservation pin mustn't keep the winner's open.
        yield* release(submission, attempt);
        return yield* commandError(
          `Another window started a Cloud Workers submission for ${project}. Press Start to check it.`,
        );
      }
    }

    // A failure before the offer runs offered nothing under this attempt, so it is closed; the
    // reservation and its other attempts stay: another server sharing this ledger may already be
    // offering under it.
    const argv = yield* args(() =>
      agentdArgs.cloudOffer(input, project, submission, fingerprint),
    ).pipe(Effect.tapError(() => release(submission, attempt)));
    yield* agentd(() => agentdArgs.cloudSession(input.cwd)).pipe(
      Effect.catchTags({
        AgentdCommandError: (error) =>
          Effect.fail(
            error.notSetUp
              ? offerError(error.message, true)
              : commandError("AgentD couldn’t prepare a session for the cloud task."),
          ),
      }),
      Effect.tapError(() => release(submission, attempt)),
    );
    // A ledger that can't be read leaves the outcome unknown, and the reservation kept.
    const reconcile = (said: string | null) =>
      recorded(submission).pipe(
        Effect.flatMap((found) => {
          if (found !== null && found.draft !== fingerprint)
            return remember(submission, found.handoff).pipe(
              Effect.as(alreadyRecorded(found.handoff, true)),
            );
          if (found !== null) {
            const handoff = found.handoff;
            return remember(submission, handoff).pipe(
              Effect.as({
                id: handoff,
                started: false,
                note:
                  (said && cloudReason(said)) ??
                  `AgentD recorded task ${handoff} but didn’t confirm that Cloud Workers accepted it. Check Background tasks for updates.`,
              } satisfies AgentdStartTaskResult),
            );
          }
          const reason = said ? cloudReason(said) : null;
          // Released only when agentd said it refused the offer before making a task; a runner or
          // network failure may still have reached the Job API under this --idem key.
          if (reason === null || said === null || !refusedBeforeTask(said))
            return Effect.fail(unknownOutcome());
          const privateFile = said ? openKeyFile(said) : null;
          return release(submission, attempt).pipe(
            Effect.andThen(
              Effect.fail(
                new AgentdCommandError({
                  message: reason,
                  notSetUp: false,
                  ...(privateFile === null ? {} : { privateFile }),
                }),
              ),
            ),
          );
        }),
      );
    const offered = yield* run(argv, { command }).pipe(Effect.result);
    if (offered._tag === "Failure") {
      const error = offered.failure;
      if (error._tag !== "AgentdCommandError") return yield* error;
      if (error.notSetUp) {
        yield* release(submission, attempt);
        return yield* offerError(error.message, true);
      }
      return yield* reconcile(error.message);
    }
    const receipt = offerReceipt(offered.success);
    if (receipt._tag === "None") return yield* reconcile(null);
    const { handoff: id, cloud } = receipt.value;
    // agentd answers a reused key only for the same request, whose --state names this draft; a
    // task the ledger shows as another draft's is that one's all the same. An unread ledger leaves
    // the receipt to stand.
    if (reused) {
      const owner = yield* recorded(submission).pipe(Effect.orElseSucceed(() => null));
      if (owner !== null && owner.handoff === id && owner.draft !== fingerprint) {
        yield* remember(submission, id);
        return alreadyRecorded(id, true);
      }
    }
    yield* remember(submission, id);
    const note = cloud?.error
      ? offerError(cloud.error).message
      : cloud === undefined
        ? "AgentD did not confirm that Cloud Workers accepted the task. Check Background tasks for updates."
        : null;
    return { id, started: note === null, note } satisfies AgentdStartTaskResult;
  });

  return { cloudSetup, cloudConfigure, startCloudTask, originProject };
});
