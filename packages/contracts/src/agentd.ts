import * as Schema from "effect/Schema";

import { AgentdBackupFileName } from "./assets.ts";

// agentd is the authority for tasks, approvals and workers; these are its `--json` answers as the
// server reads them and the shapes it serves. Fields agentd may leave out are optional or null.

export const AgentdHandoffId = Schema.String.check(Schema.isPattern(/^hof-[0-9a-f]{6,32}$/));
export type AgentdHandoffId = typeof AgentdHandoffId.Type;

export const AgentdWorkerTool = Schema.Literals(["claude", "codex", "opencode"]);
export type AgentdWorkerTool = typeof AgentdWorkerTool.Type;

export class AgentdNotFoundError extends Schema.TaggedError<AgentdNotFoundError>()(
  "AgentdNotFoundError",
  /** bundled: the desktop app carries agentd, so it is never something to install separately. */
  { message: Schema.String, bundled: Schema.optionalKey(Schema.Boolean) },
) {}

export class AgentdCommandError extends Schema.TaggedError<AgentdCommandError>()(
  "AgentdCommandError",
  {
    message: Schema.String,
    /** agentd answered that it is not set up yet (`agentd init` has not run). */
    notSetUp: Schema.Boolean,
    /** A cloud offer may have reached agentd; the next Start checks before offering again. */
    outcomeUnknown: Schema.optionalKey(Schema.Boolean),
    /** An earlier cloud submission agentd has no task for, which Start may replace with this draft. */
    replaceSubmission: Schema.optionalKey(Schema.String),
    /** A credential file of the user's that others can read; the app can make it private. */
    privateFile: Schema.optionalKey(Schema.String),
    /** The BYOK key field whose file holds the other provider's key; only to a host-file reader. */
    wrongKeyFile: Schema.optionalKey(Schema.Literals(["anthropic", "openai"])),
    /** The folder Claude Code hasn't been allowed to work in; Start asks before trusting it. */
    untrustedFolder: Schema.optionalKey(Schema.String),
    queuedStartRefusal: Schema.optionalKey(
      Schema.Literals(["no-longer-queued", "has-recipient", "no-checkout"]),
    ),
  },
) {}

export const AgentdError = Schema.Union([AgentdNotFoundError, AgentdCommandError]);
export type AgentdError = typeof AgentdError.Type;

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optionalKey(Schema.NullOr(Schema.Number));
export const AgentdCloudModelAccess = Schema.Literals(["libraos", "byok", "subscription"]);
export type AgentdCloudModelAccess = typeof AgentdCloudModelAccess.Type;
/** Whose plan a subscription job runs on: Claude Code on a Claude plan, Codex on a ChatGPT plan. */
export const AgentdCloudPlan = Schema.Literals(["claude", "codex"]);
export type AgentdCloudPlan = typeof AgentdCloudPlan.Type;

export const AgentdDoctorJson = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  set_up: Schema.optionalKey(Schema.Boolean),
  checks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      detail: Schema.optionalKey(Schema.String),
      fix: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type AgentdDoctorJson = typeof AgentdDoctorJson.Type;

export const AgentdHandoffListJsonRow = Schema.Struct({
  id: Schema.String,
  title: NullableString,
  goal: NullableString,
  state: Schema.String,
  worker_state: NullableString,
  worker_running: Schema.optionalKey(Schema.Boolean),
  a2a_state: NullableString,
  worker_cwd: NullableString,
  claimer: NullableString,
  claimer_user: NullableString,
  cloud_state: NullableString,
  project: NullableString,
  issue: NullableString,
  updated: NullableString,
  version: Schema.optionalKey(Schema.Number),
  cloud_usd: NullableNumber,
});
export type AgentdHandoffListJsonRow = typeof AgentdHandoffListJsonRow.Type;

export const AgentdHandoffListJson = Schema.Array(AgentdHandoffListJsonRow);

export const AgentdHandoffShowJson = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  title: NullableString,
  body: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        goal: NullableString,
        labels: NullableString,
        model_access: NullableString,
        /** Set on a subscription job: the credential file each plan reads (a path, never its contents). */
        claude_token_file: NullableString,
        codex_auth_file: NullableString,
        state: Schema.optionalKey(NullableString),
      }),
    ),
  ),
  accept: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  check_cmd: NullableString,
  verdict: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        verdict: Schema.String,
        check: NullableString,
        delivery: NullableString,
        next: NullableString,
      }),
    ),
  ),
  cost: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        total: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
              estimate: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
      }),
    ),
  ),
  to_session: NullableString,
  to_user: NullableString,
  role: NullableString,
  claimer: NullableString,
  worker_running: Schema.optionalKey(Schema.Boolean),
  a2a_state: NullableString,
  required_labels: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  queue_reason: NullableString,
  parked: NullableString,
  lease_started: NullableString,
  dispatched: NullableString,
  history: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          state: Schema.String,
          created: NullableString,
          kind: NullableString,
          note: NullableString,
        }),
      ),
    ),
  ),
  worker_cwd: NullableString,
  origin: Schema.optionalKey(Schema.NullOr(Schema.Struct({ dir: NullableString }))),
  budget: NullableString,
  budget_state: NullableString,
  worker_state: NullableString,
  worker_tool: NullableString,
  worker: NullableString,
  start_tool: NullableString,
  worker_branch: NullableString,
  lease_branch: NullableString,
  lease_device: NullableString,
  cloud_state: NullableString,
  worker_log: NullableString,
  worker_note: NullableString,
  worker_wait: NullableString,
  report_note: NullableString,
  close_reason: NullableString,
  project: NullableString,
  /** Pull requests linked to the task, as OWNER/REPO#N. */
  prs: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  created: NullableString,
  updated: NullableString,
  cloud: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        state: NullableString,
        worker_usd: NullableNumber,
        inference_usd: NullableNumber,
        total_usd: NullableNumber,
        note: NullableString,
        result: NullableString,
      }),
    ),
  ),
});
export type AgentdHandoffShowJson = typeof AgentdHandoffShowJson.Type;

export const AgentdApprovalListJson = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    action: NullableString,
    handoff: NullableString,
    project: NullableString,
    ref: NullableString,
    session: NullableString,
    required_role: NullableString,
    created: NullableString,
  }),
);

export const AgentdInboxListJson = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    from: NullableString,
    claimer: NullableString,
    title: NullableString,
    goal: NullableString,
    handoff: NullableString,
    at: NullableString,
    read: Schema.optionalKey(Schema.Boolean),
    resolved: Schema.optionalKey(Schema.Boolean),
  }),
);

export const AgentdUserListJson = Schema.Array(
  Schema.Struct({ name: Schema.String, role: Schema.String, created: NullableString }),
);

export const AgentdWhoJson = Schema.Struct({
  holders: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: NullableString,
          session: NullableString,
          tool: NullableString,
          node: NullableString,
          path: NullableString,
          resource: NullableString,
          since: NullableString,
          handoff: NullableString,
          issue: NullableString,
          activity: NullableString,
          state: NullableString,
          via: NullableString,
        }),
      ),
    ),
  ),
  resource: NullableString,
  server: NullableString,
  server_note: NullableString,
});

export const AgentdDoctorCheck = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  detail: Schema.NullOr(Schema.String),
  fix: Schema.NullOr(Schema.String),
});
export type AgentdDoctorCheck = typeof AgentdDoctorCheck.Type;

/** The desktop app's last pass installing its agentd and Skills for the terminal and agents. */
export const AgentdInstallRecord = Schema.Struct({
  action: Schema.Literals(["installed", "replaced", "unchanged", "kept-newer", "kept-unknown"]),
  /** The install.sh location; a kept agentd there is the person's own. */
  path: Schema.String,
  directory: Schema.String,
  onPath: Schema.Boolean,
  /** The line to add to a shell profile when the folder is not on PATH; the app never edits one. */
  pathLine: Schema.NullOr(Schema.String),
  skills: Schema.Array(Schema.String),
});
export type AgentdInstallRecord = typeof AgentdInstallRecord.Type;

export const AgentdServiceName = Schema.Literals(["watchdog", "dash"]);
export type AgentdServiceName = typeof AgentdServiceName.Type;

/** agentd services that run a missing agentd or the old AgentD Desktop's: reported, never moved. */
export const AgentdServicesProblem = Schema.Struct({
  services: Schema.Array(Schema.Struct({ name: AgentdServiceName, program: Schema.String })),
  /** The agentd Repair registers; null when this app's is gone once it quits (an AppImage). */
  agentd: Schema.NullOr(Schema.String),
  /** The services Repair re-registers; empty when it isn't offered. */
  moves: Schema.Array(AgentdServiceName),
  /** Services on another working agentd that install would also move, so Repair isn't offered. */
  kept: Schema.optionalKey(Schema.Array(AgentdServiceName)),
  /** Services whose registration couldn't be read (macOS, Windows): install would rewrite them too. */
  unread: Schema.optionalKey(Schema.Array(AgentdServiceName)),
  /** Stale services whose program a systemd drop-in sets, which install doesn't rewrite. */
  overridden: Schema.optionalKey(Schema.Array(AgentdServiceName)),
  /** What agentd install asked the user to run first, before it would enable the services. */
  command: Schema.optionalKey(Schema.String),
  /** Linux: the watchdog runs this app's agentd, but systemd hasn't enabled or started its timer. */
  watchdogOff: Schema.optionalKey(Schema.Boolean),
});
export type AgentdServicesProblem = typeof AgentdServicesProblem.Type;

/** What the user confirmed Repair re-registers: refused when a fresh check would move others. */
export const AgentdServicesRepairInput = Schema.Struct({ moves: Schema.Array(AgentdServiceName) });
export type AgentdServicesRepairInput = typeof AgentdServicesRepairInput.Type;

export const AgentdServicesRepairResult = Schema.Struct({
  ok: Schema.Boolean,
  /** What agentd install asked the user to run first, before it would enable the services. */
  command: Schema.optionalKey(Schema.String),
});
export type AgentdServicesRepairResult = typeof AgentdServicesRepairResult.Type;

export const AgentdStatus = Schema.Struct({
  /** `agentd version` as it printed it, such as "agentd v0.1.13 0d0b360a58c0". */
  version: Schema.String,
  ok: Schema.Boolean,
  setUp: Schema.Boolean,
  defaultWorker: Schema.optionalKey(Schema.NullOr(AgentdWorkerTool)),
  /**
   * Whether a local worker can take a dollar budget: agentd refuses one while its model prices are
   * empty. Null when agentd did not say.
   */
  dollarBudgets: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  teamServer: NullableString,
  checks: Schema.Array(AgentdDoctorCheck),
  /** The agentd binary the app runs. */
  binary: Schema.optionalKey(Schema.String),
  install: Schema.optionalKey(Schema.NullOr(AgentdInstallRecord)),
  /** agentd's services on a missing or old agentd, as last checked; null when none. */
  servicesProblem: Schema.optionalKey(Schema.NullOr(AgentdServicesProblem)),
  /** No config.toml yet, so `agentd init` still takes a permission mode. */
  firstSetup: Schema.optionalKey(Schema.Boolean),
});
export type AgentdStatus = typeof AgentdStatus.Type;

/** What Settings needs of the gateway this machine's workers use. */
export const AgentdWorkerGateway = Schema.Struct({
  /** False on an agentd without `config set dispatch.TOOL_base_url`. */
  supported: Schema.Boolean,
  /** `[dispatch] TOOL_model` per tool; "" when the tool picks its own. */
  models: Schema.Record(AgentdWorkerTool, Schema.String),
  /** The custom gateway this app last set for each tool; agentd does not show the URL it holds. */
  chosen: Schema.Record(AgentdWorkerTool, Schema.NullOr(Schema.String)),
});
export type AgentdWorkerGateway = typeof AgentdWorkerGateway.Type;

export const AgentdWorkerGatewayInput = Schema.Struct({
  tool: AgentdWorkerTool,
  /** One of this environment's custom gateways and a model of it; null goes back to the tool's own login. */
  gateway: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String.check(Schema.isMaxLength(256)),
    }),
  ),
});
export type AgentdWorkerGatewayInput = typeof AgentdWorkerGatewayInput.Type;

/** Where a task's worker runs: this machine, a team node that leased it, or agentd's cloud. */
export const AgentdRunsOn = Schema.Literals(["local", "team", "cloud"]);
export type AgentdRunsOn = typeof AgentdRunsOn.Type;

export const AgentdTaskRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  state: Schema.String,
  workerState: Schema.NullOr(Schema.String),
  workerRunning: Schema.Boolean,
  /** From the claiming session; `handoff list` names no worker tool. */
  workerTool: Schema.NullOr(Schema.String),
  workerName: NullableString,
  /** The checkout the task was offered in; the worker runs in a worktree of it. */
  workerCwd: NullableString,
  runsOn: AgentdRunsOn,
  project: Schema.NullOr(Schema.String),
  issue: Schema.NullOr(Schema.String),
  /** Null in the list: `handoff list --json` carries neither; `agentd.task` has both. */
  started: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  updated: Schema.NullOr(Schema.String),
  cloudState: NullableString,
  a2aState: NullableString,
  cloudUsd: NullableNumber,
});
export type AgentdTaskRow = typeof AgentdTaskRow.Type;

export const AgentdTaskVerdict = Schema.Struct({
  verdict: Schema.String,
  check: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
});
export type AgentdTaskVerdict = typeof AgentdTaskVerdict.Type;

export const AgentdTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  state: Schema.String,
  workerState: Schema.NullOr(Schema.String),
  workerTool: Schema.NullOr(Schema.String),
  runsOn: AgentdRunsOn,
  accept: Schema.Array(Schema.String),
  check: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(AgentdTaskVerdict),
  costUsd: Schema.NullOr(Schema.Number),
  costEstimate: Schema.Boolean,
  budget: Schema.NullOr(Schema.String),
  budgetState: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  /** The worker's latest progress report, while it runs. */
  report: Schema.optionalKey(Schema.String),
  /** What a blocked worker waits for, as agentd recorded it (a permission prompt, a question). */
  waitingFor: Schema.optionalKey(Schema.String),
  /** The terminal command that opens a blocked worker's own session to answer it. */
  attachCommand: Schema.optionalKey(Schema.String),
  project: Schema.NullOr(Schema.String),
  hasLog: Schema.Boolean,
  started: Schema.NullOr(Schema.String),
  created: NullableString,
  queuedSince: NullableString,
  parked: Schema.optionalKey(Schema.String),
  queueBlock: Schema.optionalKey(Schema.String),
  queuePickup: Schema.optionalKey(Schema.Literals(["recipient", "remote", "remote-eligible"])),
  startFolder: NullableString,
  updated: Schema.NullOr(Schema.String),
  cloud: Schema.optionalKey(
    Schema.Struct({
      state: Schema.String,
      modelAccess: Schema.NullOr(AgentdCloudModelAccess),
      /** The plan a subscription job bills; null for other model access. */
      plan: Schema.optionalKey(Schema.NullOr(AgentdCloudPlan)),
      workerUsd: Schema.NullOr(Schema.Number),
      inferenceUsd: Schema.NullOr(Schema.Number),
      totalUsd: Schema.NullOr(Schema.Number),
      /** The task's own PR, else GitHub's compare page for its pushed branch; null without either. */
      pullRequest: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ url: Schema.String, number: Schema.NullOr(Schema.Number) })),
      ),
    }),
  ),
});
export type AgentdTask = typeof AgentdTask.Type;

export const AgentdApproval = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  requester: NullableString,
  action: Schema.NullOr(Schema.String),
  handoff: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  ref: Schema.NullOr(Schema.String),
  requiredRole: Schema.NullOr(Schema.String),
  created: Schema.NullOr(Schema.String),
});
export type AgentdApproval = typeof AgentdApproval.Type;

export const AgentdInboxItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  requester: NullableString,
  handoff: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
  read: Schema.Boolean,
  resolved: Schema.Boolean,
});
export type AgentdInboxItem = typeof AgentdInboxItem.Type;

export const AgentdPerson = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  created: Schema.NullOr(Schema.String),
});
export type AgentdPerson = typeof AgentdPerson.Type;

export const AgentdHolder = Schema.Struct({
  user: Schema.NullOr(Schema.String),
  tool: Schema.NullOr(Schema.String),
  node: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.String),
});
export type AgentdHolder = typeof AgentdHolder.Type;

export const AgentdNode = Schema.Struct({
  name: Schema.String,
  host: Schema.String,
  person: Schema.NullOr(Schema.String),
  state: Schema.String,
  why: Schema.NullOr(Schema.String),
  seen: Schema.String,
  offline: Schema.Boolean,
});
export type AgentdNode = typeof AgentdNode.Type;

export const AgentdPeople = Schema.Struct({
  people: Schema.Array(AgentdPerson),
  /** Who works at `target` now (`agentd who`); empty without a target. */
  holders: Schema.Array(AgentdHolder),
  nodes: Schema.optionalKey(Schema.Array(AgentdNode)),
});
export type AgentdPeople = typeof AgentdPeople.Type;

const TaskText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
// POSIX, a Windows drive (C:\ or C:/) or a UNC share (\\host\share).
const AbsolutePath = Schema.String.check(Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/));
const IssueRef = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}#[1-9]\d{0,9}$/),
);

export const AgentdTaskInput = Schema.Struct({ id: AgentdHandoffId });
export type AgentdTaskInput = typeof AgentdTaskInput.Type;

export const AgentdStopTaskInput = Schema.Struct({ id: AgentdHandoffId, reason: TaskText });
export type AgentdStopTaskInput = typeof AgentdStopTaskInput.Type;

export const AgentdStartTaskInput = Schema.Struct({
  goal: TaskText,
  accept: Schema.Array(TaskText).check(Schema.isMaxLength(20)),
  /** Null runs the task with no check (`--no-check`). */
  check: Schema.NullOr(TaskText),
  worker: AgentdWorkerTool,
  budget: Schema.String.check(
    Schema.isPattern(/^(?:\d{1,4}m|\$\d{1,4}(?:\.\d{1,2})?|\d{1,4}m,\$\d{1,4}(?:\.\d{1,2})?)$/),
  ),
  cwd: AbsolutePath,
  issue: Schema.NullOr(IssueRef),
  /** The person agreed to let Claude Code work in the folder an untrustedFolder refusal named. */
  trustClaudeFolder: Schema.optionalKey(Schema.Boolean),
  cloud: Schema.optionalKey(Schema.Never),
});
export type AgentdStartTaskInput = typeof AgentdStartTaskInput.Type;

/** The open task agentd named when it refused a dispatch into the same directory or issue. */
export const AgentdBlockingTask = Schema.Struct({
  id: AgentdHandoffId,
  state: Schema.String,
  goal: Schema.NullOr(Schema.String),
  /** Its worker still runs, so Release would stop live work: the app does not offer it. */
  running: Schema.Boolean,
});
export type AgentdBlockingTask = typeof AgentdBlockingTask.Type;

export const AgentdStartTaskResult = Schema.Struct({
  id: Schema.String,
  started: Schema.Boolean,
  /** Why dispatch failed; the task stays offered in agentd. */
  note: Schema.NullOr(Schema.String),
  blocking: Schema.optionalKey(AgentdBlockingTask),
  /** The task is an earlier cloud submission agentd found; nothing from this Start was sent. */
  earlier: Schema.optionalKey(Schema.Boolean),
});
export type AgentdStartTaskResult = typeof AgentdStartTaskResult.Type;

/** Dispatch an existing offered task, optionally resolving a conflict from an earlier start. */
export const AgentdRetryStartInput = Schema.Union([
  Schema.Struct({
    id: AgentdHandoffId,
    worker: AgentdWorkerTool,
    action: Schema.Literals(["release", "force"]),
    blocking: AgentdHandoffId,
    queued: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    id: AgentdHandoffId,
    worker: AgentdWorkerTool,
    action: Schema.Literals(["queued", "parked"]),
    trustedFolder: Schema.optionalKey(AbsolutePath),
  }),
]);
export type AgentdRetryStartInput = typeof AgentdRetryStartInput.Type;

export const AgentdPeopleInput = Schema.Struct({
  target: Schema.optionalKey(Schema.Union([AbsolutePath, IssueRef])),
  includeNodes: Schema.optionalKey(Schema.Boolean),
});
export type AgentdPeopleInput = typeof AgentdPeopleInput.Type;

export const AgentdConnectAgentInput = Schema.Struct({
  agent: AgentdWorkerTool,
  dryRun: Schema.Boolean,
});
export type AgentdConnectAgentInput = typeof AgentdConnectAgentInput.Type;

export const AgentdJoinTeamInput = Schema.Struct({
  server: Schema.String.check(Schema.isMaxLength(2048)),
  /** Goes to agentd's stdin only, never into an argument list or a log. */
  ticket: Schema.String.check(Schema.isMaxLength(256)),
});
export type AgentdJoinTeamInput = typeof AgentdJoinTeamInput.Type;

/** What agentd printed for a command with no JSON answer (connect, join). */
export const AgentdCommandOutput = Schema.Struct({ output: Schema.String });
export type AgentdCommandOutput = typeof AgentdCommandOutput.Type;

/**
 * A backup of agentd's ledger, encrypted to an age public key (age1...) that the asking device
 * made and keeps the private key of: no secret reaches this host, and the file is useless to anyone
 * without that device's key.
 */
export const AgentdBackupRecipient = Schema.String.check(
  Schema.isPattern(/^age1[02-9ac-hj-np-z]{58}$/),
);
export const AgentdBackupCreateInput = Schema.Struct({ recipient: AgentdBackupRecipient });
export type AgentdBackupCreateInput = typeof AgentdBackupCreateInput.Type;

/** The backup made, with a signed URL to download it from until expiresAt. */
export const AgentdBackupCreated = Schema.Struct({
  fileName: AgentdBackupFileName,
  bytes: Schema.Number,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  created: Schema.String,
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export type AgentdBackupCreated = typeof AgentdBackupCreated.Type;

export const AgentdCloudKeyFile = AbsolutePath.check(Schema.isPattern(/^[^\0\r\n]{2,4096}$/));
export const AgentdCloudBudget = Schema.String.check(
  Schema.isPattern(/^(?:(?!0+m)[0-9]{1,4}m,)?\$(?!0+(?:\.0{1,2})?$)[0-9]{1,4}(?:\.[0-9]{1,2})?$/),
);
export const AgentdCloudTaskInput = Schema.Struct({
  goal: AgentdStartTaskInput.fields.goal,
  accept: AgentdStartTaskInput.fields.accept,
  check: AgentdStartTaskInput.fields.check,
  cwd: AbsolutePath,
  cloud: Schema.Struct({
    budget: AgentdCloudBudget,
    modelAccess: AgentdCloudModelAccess,
    anthropicKeyFile: Schema.optionalKey(AgentdCloudKeyFile),
    openaiKeyFile: Schema.optionalKey(AgentdCloudKeyFile),
    /** With subscription: the plan, and the file that overrides its configured one for this task. */
    plan: Schema.optionalKey(AgentdCloudPlan),
    claudeTokenFile: Schema.optionalKey(AgentdCloudKeyFile),
    codexAuthFile: Schema.optionalKey(AgentdCloudKeyFile),
    /** The user saw that agentd has no task for this earlier submission and offers this draft in its place. */
    replaceSubmission: Schema.optionalKey(
      Schema.String.check(
        Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/),
      ),
    ),
  }),
});
export type AgentdCloudTaskInput = typeof AgentdCloudTaskInput.Type;

export const AgentdCloudSetupInput = Schema.Struct({
  /** Null reads the account alone, with no project (the AgentD page). */
  cwd: Schema.NullOr(AbsolutePath),
  includeBalance: Schema.Boolean,
});
export type AgentdCloudSetupInput = typeof AgentdCloudSetupInput.Type;
/** One plan's credential as agentd reports it; the app never opens the file. */
export const AgentdCloudPlanState = Schema.Struct({
  /** The installed agentd takes this plan's jobs. */
  supported: Schema.Boolean,
  configured: Schema.Boolean,
  /** Null when agentd cannot say without a job. */
  valid: Schema.NullOr(Schema.Boolean),
  /** About when the credential runs out, YYYY-MM-DD. */
  expiresAbout: Schema.NullOr(Schema.String),
});
export type AgentdCloudPlanState = typeof AgentdCloudPlanState.Type;
export const AgentdCloudSubscription = Schema.Struct({
  claude: AgentdCloudPlanState,
  codex: AgentdCloudPlanState,
  /** Setting a plan up is not offered on this host (Windows); a configured one still runs. */
  setupUnavailable: Schema.Boolean,
});
export type AgentdCloudSubscription = typeof AgentdCloudSubscription.Type;
/** A plan account's worker minutes this month, as `agentd cloud balance` reports them. */
export const AgentdCloudPlanUsage = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  includedMinutes: Schema.NullOr(Schema.Number),
  usedMinutes: Schema.NullOr(Schema.Number),
  reservedMinutes: Schema.NullOr(Schema.Number),
  leftMinutes: Schema.NullOr(Schema.Number),
  /** RFC 3339; null when agentd didn't give a valid one. */
  monthEndsAt: Schema.NullOr(Schema.String),
});
export type AgentdCloudPlanUsage = typeof AgentdCloudPlanUsage.Type;
export const AgentdCloudSetup = Schema.Struct({
  supported: Schema.Boolean,
  /** agentd did not answer the cloud probe; whether it has Cloud Workers is unknown. */
  unreachable: Schema.optionalKey(Schema.Boolean),
  /** git didn't answer for the checkout's origin (timeout, spawn error): retry, don't run here. */
  checkoutUnknown: Schema.optionalKey(Schema.Boolean),
  /** agentd has `cloud setup`, so the app can install the account key. */
  canConfigure: Schema.optionalKey(Schema.Boolean),
  /** The Job API `cloud setup` sends the account key to; null when agentd didn't say. */
  setupUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Null when this agentd has no subscription jobs or the balance was not read. */
  subscription: Schema.optionalKey(Schema.NullOr(AgentdCloudSubscription)),
  project: Schema.NullOr(Schema.String),
  balanceUsd: Schema.NullOr(Schema.Number),
  balanceText: Schema.NullOr(Schema.String),
  /** Absent when the balance was not read or the account has no plan. */
  plan: Schema.optionalKey(Schema.NullOr(AgentdCloudPlanUsage)),
  defaultBudget: Schema.NullOr(AgentdCloudBudget),
  problem: Schema.NullOr(Schema.Literals(["setup", "credit", "repository", "balance"])),
});
export type AgentdCloudSetup = typeof AgentdCloudSetup.Type;

/** A Cloud Workers account key for `agentd cloud setup`; goes to agentd's stdin only. */
export const AgentdCloudConfigureInput = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  /** The Job API the user was shown; the key goes there and nowhere else. */
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export type AgentdCloudConfigureInput = typeof AgentdCloudConfigureInput.Type;
export const AgentdCloudConfigured = Schema.Struct({
  balanceUsd: Schema.NullOr(Schema.Number),
});
export type AgentdCloudConfigured = typeof AgentdCloudConfigured.Type;

/** A key file the user chose for Cloud Workers, checked on the environment's host. */
export const AgentdCloudKeyFileInput = Schema.Struct({ path: AgentdCloudKeyFile });
export type AgentdCloudKeyFileInput = typeof AgentdCloudKeyFileInput.Type;
export const AgentdCloudKeyFileCheck = Schema.Struct({
  /** Whose key the file holds, by its first bytes only; null when unreadable or unrecognised. */
  provider: Schema.NullOr(Schema.Literals(["anthropic", "openai"])),
  readable: Schema.Boolean,
  /** Other users can read or write it (never on Windows, where agentd checks no mode). */
  openToOthers: Schema.Boolean,
});
export type AgentdCloudKeyFileCheck = typeof AgentdCloudKeyFileCheck.Type;

interface CloudKeyFileEntry {
  readonly anthropic?: string;
  readonly openai?: string;
  readonly anthropicSavedAt?: number;
  readonly openaiSavedAt?: number;
}
type CloudKeyFiles = Readonly<Record<string, CloudKeyFileEntry>>;

/**
 * Settings to store with each provider's BYOK path the newer of stored and incoming, by when it
 * was remembered, so a window saving from an old snapshot (a budget edit, say) can't restore a
 * path another window replaced, nor erase one it added. A tie keeps the stored path.
 */
export function withStoredCloudKeyFiles<S extends { readonly agentdCloudKeyFiles: CloudKeyFiles }>(
  stored: { readonly agentdCloudKeyFiles: CloudKeyFiles } | null,
  incoming: S,
): S {
  if (stored === null) return incoming;
  const merged: Record<string, CloudKeyFileEntry> = { ...stored.agentdCloudKeyFiles };
  for (const [environment, files] of Object.entries(incoming.agentdCloudKeyFiles)) {
    const entry: { -readonly [K in keyof CloudKeyFileEntry]: CloudKeyFileEntry[K] } = {
      ...merged[environment],
    };
    for (const provider of ["anthropic", "openai"] as const) {
      const at = `${provider}SavedAt` as const;
      const path = files[provider];
      if (path === undefined) continue;
      if (entry[provider] !== undefined && (files[at] ?? 0) <= (entry[at] ?? 0)) continue;
      entry[provider] = path;
      if (files[at] === undefined) delete entry[at];
      else entry[at] = files[at];
    }
    merged[environment] = entry;
  }
  return { ...incoming, agentdCloudKeyFiles: merged };
}

/** The terminal command that makes a key file private, its path quoted for a POSIX shell. */
export function chmodPrivateCommand(path: string): string {
  const word = /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
  return `chmod 600 ${word}`;
}

/** A finished cloud task's pushed branch, compared in a checkout whose origin is its repository. */
export const AgentdCloudReviewInput = Schema.Struct({ id: AgentdHandoffId, cwd: AbsolutePath });
export type AgentdCloudReviewInput = typeof AgentdCloudReviewInput.Type;
export const AgentdCloudReview = Schema.Struct({
  branch: Schema.String,
  /** The branch's changes against the repository's default branch, as a unified diff. */
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type AgentdCloudReview = typeof AgentdCloudReview.Type;
/** The size a chat draft gives a task; it only chooses which of agentd's estimates to use. */
export const AgentdTaskSize = Schema.Literals(["small", "feature", "complex", ""]);
export type AgentdTaskSize = typeof AgentdTaskSize.Type;
export const AgentdTaskDefaultsInput = Schema.Struct({
  cwd: AbsolutePath,
  size: AgentdTaskSize,
});
export type AgentdTaskDefaultsInput = typeof AgentdTaskDefaultsInput.Type;
/** What `agentd handoff estimate` says similar past jobs cost, in dollars. */
export const AgentdTaskEstimate = Schema.Struct({
  type: Schema.Literals(["small", "feature", "complex", "implement"]),
  low: Schema.Number,
  median: Schema.Number,
  high: Schema.Number,
  jobs: Schema.Number,
});
export type AgentdTaskEstimate = typeof AgentdTaskEstimate.Type;
export const AgentdTaskDefaults = Schema.Struct({
  /** Null when agentd has too few past jobs of the type, or cannot estimate. */
  estimate: Schema.NullOr(AgentdTaskEstimate),
  /** A check command suggested from the project's files on the environment's host. */
  check: Schema.NullOr(Schema.String),
});
export type AgentdTaskDefaults = typeof AgentdTaskDefaults.Type;

export const AgentdTaskOthersInput = Schema.Struct({
  cwd: AbsolutePath,
  issue: Schema.NullOr(IssueRef),
});
export type AgentdTaskOthersInput = typeof AgentdTaskOthersInput.Type;

export const AgentdTaskOther = Schema.Struct({
  person: Schema.NullOr(Schema.String),
  work: Schema.NullOr(Schema.String),
  activity: Schema.NullOr(Schema.String),
  paths: Schema.Array(Schema.String),
});
export type AgentdTaskOther = typeof AgentdTaskOther.Type;
/** This environment as a team node: `agentd worker --accept-server-work`, run by the server. */
export const AgentdTeamNodeState = Schema.Literals(["off", "waiting", "working", "failed"]);
export type AgentdTeamNodeState = typeof AgentdTeamNodeState.Type;

export const AgentdTeamNodeStatus = Schema.Struct({
  on: Schema.Boolean,
  tool: Schema.NullOr(AgentdWorkerTool),
  repo: Schema.NullOr(Schema.String),
  state: AgentdTeamNodeState,
  /** The task the node's worker leased, while working. */
  task: Schema.NullOr(Schema.String),
  /** What agentd said when the worker failed or ended. */
  note: Schema.NullOr(Schema.String),
  /** Installed agents among claude, codex and opencode. */
  tools: Schema.Array(AgentdWorkerTool),
});
export type AgentdTeamNodeStatus = typeof AgentdTeamNodeStatus.Type;

export const AgentdTeamNodeInput = Schema.Struct({
  on: Schema.Boolean,
  tool: AgentdWorkerTool,
  repo: AbsolutePath,
  /** A worker enrolment ticket, if agentd needs one; goes to agentd's stdin only. */
  ticket: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type AgentdTeamNodeInput = typeof AgentdTeamNodeInput.Type;

/** The agreement this agentd carries (`agentd eula`), shown before `agentd init` accepts it. */
export const AgentdEula = Schema.Struct({
  /** As the text names it ("3.5"); null when it names none. */
  version: Schema.NullOr(Schema.String),
  text: Schema.String,
});
export type AgentdEula = typeof AgentdEula.Type;

/** The environment's `agentd init` run, started by the person's Accept. */
export const AgentdSetupState = Schema.Struct({
  phase: Schema.Literals(["idle", "running", "succeeded", "failed"]),
  /** Counts the runs since the server started, so a client follows the run its click began. */
  attempt: Schema.Number,
  /** What init printed, escape sequences removed; the tail when long. */
  output: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  /** Why the app ended init: it asked something besides the EULA, ran too long, or did not start. */
  stopped: Schema.NullOr(Schema.Literals(["prompt", "timeout", "spawn"])),
  /** The person chose a permission mode but this agentd's init takes no `--permission-mode`. */
  permissionModeIgnored: Schema.optionalKey(Schema.Boolean),
});
export type AgentdSetupState = typeof AgentdSetupState.Type;

/** How much agentd's workers may do without asking (`[dispatch] permission_mode`). */
export const AgentdPermissionMode = Schema.Literals(["guarded", "yolo"]);
export type AgentdPermissionMode = typeof AgentdPermissionMode.Type;

export const AgentdSetupStartInput = Schema.Struct({
  /** Asked at first setup only; agentd refuses the flag once a config exists. */
  permissionMode: Schema.optionalKey(AgentdPermissionMode),
});
export type AgentdSetupStartInput = typeof AgentdSetupStartInput.Type;

/** The mode as agentd holds it; the app keeps no copy. */
export const AgentdPermissionModeState = Schema.Struct({
  /** The global mode; null when this agentd does not report one. */
  mode: Schema.NullOr(AgentdPermissionMode),
  /** A role or repository set to yolo runs its workers without asking whatever the global mode. */
  scopedYolo: Schema.Boolean,
});
export type AgentdPermissionModeState = typeof AgentdPermissionModeState.Type;
