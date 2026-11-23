import * as Schema from "effect/Schema";

import {
  handoffRecord,
  attemptRecord,
  offerState,
  releaseRecord,
  reserveRecord,
  submissionMarker,
} from "./agentdCloudSubmissions.ts";
import type {
  AgentdCloudTaskInput,
  AgentdConnectAgentInput,
  AgentdStartTaskInput,
  AgentdWorkerTool,
} from "@t3tools/contracts";

// Every agentd command the server runs, as a fixed argument list. Client text reaches one only as a
// validated id, path, URL or task field, never as a flag; the joinTeam ticket goes on stdin.

const HANDOFF_ID = /^hof-[0-9a-f]{6,32}$/;
const TICKET = /^adt_[A-Za-z0-9_-]{16,200}$/;

export class AgentdArgumentError extends Schema.TaggedError<AgentdArgumentError>()(
  "AgentdArgumentError",
  { message: Schema.String },
) {}

function handoffId(value: string): string {
  if (!HANDOFF_ID.test(value)) throw new AgentdArgumentError({ message: "not an agentd task id" });
  return value;
}

// agentd would read a leading dash as one of its own flags.
function text(name: string, value: string): string {
  if (value.trim() === "" || value.includes("\0")) {
    throw new AgentdArgumentError({ message: `${name} is empty or has a NUL` });
  }
  if (value.trimStart().startsWith("-")) {
    throw new AgentdArgumentError({ message: `${name} cannot start with "-"` });
  }
  return value;
}

const CLOUD_SESSION = "agentd-new";

const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

function backupRecipient(value: string): string {
  if (!AGE_RECIPIENT.test(value)) {
    throw new AgentdArgumentError({ message: "not an age public key (age1...)" });
  }
  return value;
}

function absolute(value: string): string {
  if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value) || value.includes("\0")) {
    throw new AgentdArgumentError({ message: "not an absolute path" });
  }
  return value;
}

/** An agentd server's address: http(s) with a host, normalized so agentd cannot read it as a flag. */
function agentdServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AgentdArgumentError({
      message: "the server address must be an http:// or https:// URL",
    });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new AgentdArgumentError({
      message: "the server address must be an http:// or https:// URL",
    });
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** A Job API URL as `cloud setup` reported it: https, or http to loopback, with no query. */
function jobApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentdArgumentError({ message: "the Job API address must be a URL" });
  }
  const loopback = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AgentdArgumentError({ message: "the Job API address must be an https:// URL" });
  }
  return value;
}

export function agentdTicket(value: string): string {
  const ticket = value.trim();
  if (!TICKET.test(ticket)) {
    throw new AgentdArgumentError({ message: "that is not an agentd ticket (one starts adt_)" });
  }
  return ticket;
}

// A subscription job names its plan's file only when one is chosen; else agentd reads its config.
function subscriptionFile(cloud: AgentdCloudTaskInput["cloud"]): ReadonlyArray<string> {
  if (cloud.modelAccess !== "subscription") return [];
  if (cloud.plan === "codex")
    return cloud.codexAuthFile === undefined
      ? []
      : ["--codex-auth-file", text("ChatGPT auth file", cloud.codexAuthFile)];
  return cloud.claudeTokenFile === undefined
    ? []
    : ["--claude-token-file", text("Claude token file", cloud.claudeTokenFile)];
}

export const agentdArgs = {
  version: () => ["version"],
  doctor: () => ["doctor", "--json"],
  defaultWorker: () => ["config", "get", "dispatch.default_tool"],
  configHelp: () => ["config", "--help"],
  workerModel: (tool: AgentdWorkerTool) => ["config", "get", `dispatch.${tool}_model`],
  /** `url` "" clears the gateway and its key file. */
  setWorkerGateway: (tool: AgentdWorkerTool, url: string, keyFile: string | null) => [
    "config",
    "set",
    `dispatch.${tool}_base_url`,
    url === "" ? "" : agentdServerUrl(url),
    ...(keyFile === null ? [] : ["--key-file", text("key file", keyFile)]),
  ],
  setWorkerModel: (tool: AgentdWorkerTool, model: string) => [
    "config",
    "set",
    `dispatch.${tool}_model`,
    model === "" ? "" : text("model", model),
  ],
  budgetPrices: () => ["config", "get", "budget.prices"],
  list: () => ["handoff", "list", "--json"],
  show: (id: string) => ["handoff", "show", handoffId(id), "--json"],
  approvals: () => ["approval", "list", "--state", "pending", "--json"],
  inbox: () => ["inbox", "list", "--mine", "--json"],
  users: () => ["user", "list", "--json"],
  nodes: () => ["server", "nodes", "--json"],
  who: (target: string) => ["who", text("target", target), "--json"],
  cancel: (id: string, reason: string) => [
    "handoff",
    "done",
    handoffId(id),
    "--cancel",
    "--reason",
    text("reason", reason),
  ],
  // `new` only offers: dispatch gives the worker its own worktree instead of the person's checkout.
  new: (input: AgentdStartTaskInput) => [
    "new",
    text("goal", input.goal),
    ...input.accept.flatMap((line, i) => ["--accept", text(`acceptance line ${i + 1}`, line)]),
    ...(input.check === null ? ["--no-check"] : ["--verify", text("check", input.check)]),
    ...(input.issue === null ? [] : ["--issue", input.issue]),
    "--worker",
    input.worker,
    "--budget",
    input.budget,
    "--cwd",
    input.cwd,
    "--no-start",
  ],
  // force starts past an open task holding the directory or issue, after the person chose to.
  dispatch: (id: string, worker: AgentdWorkerTool, force = false) => [
    "handoff",
    "dispatch",
    handoffId(id),
    "--tool",
    worker,
    ...(force ? ["--force"] : []),
  ],
  connectAgent: (input: AgentdConnectAgentInput) => [
    "connect",
    input.agent,
    ...(input.dryRun ? ["--dry-run"] : []),
  ],
  joinTeam: (server: string) => [
    "connect",
    "--server",
    agentdServerUrl(server),
    "--ticket-file",
    "-",
  ],
  // The public key only: the private key never leaves the device that asked.
  backupCreate: (output: string, recipient: string) => [
    "backup",
    "create",
    "-o",
    absolute(output),
    "--recipient",
    backupRecipient(recipient),
    "--json",
  ],
  cloudHelp: () => ["handoff", "offer", "--help"],
  cloudBalance: () => ["cloud", "balance", "--json"],
  cloudCommands: () => ["help", "cloud"],
  // The Job API setup would send the key to; reads no key and writes nothing.
  cloudSetupTarget: () => ["cloud", "setup", "--dry-run", "--json"],
  // The account key goes on stdin only, to the Job API the user was shown.
  cloudConfigure: (url: string) => [
    "cloud",
    "setup",
    "--url",
    jobApiUrl(url),
    "--key-file",
    "-",
    "--json",
  ],
  // The per-plan credential report; older agentd answers the config keys below.
  cloudSubscription: () => ["cloud", "subscription", "--json"],
  configGet: (
    key: "cloud.claude_token_file" | "cloud.claude_token_expires_about" | "cloud.codex_auth_file",
  ) => ["config", "get", key, "--json"],
  estimate: (type: "small" | "feature" | "complex" | "implement") => [
    "handoff",
    "estimate",
    "--type",
    type,
    "--json",
  ],
  cloudSession: (cwd: string) => [
    "session",
    "join",
    "--id",
    CLOUD_SESSION,
    "--tool",
    "other",
    "--label",
    "agentd new",
    "--wake",
    "pull",
    "--cwd",
    text("working directory", cwd),
  ],
  cloudSync: () => ["cloud", "sync"],
  submissionPins: (session: string) => ["pin", "list", "--session", session, "--json"],
  reserveSubmission: (
    session: string,
    id: string,
    after: string | null,
    fingerprint: string,
    nonce: string,
  ) => ["pin", "add", reserveRecord(id, after, fingerprint, nonce), "--session", session, "--json"],
  rememberSubmission: (session: string, id: string, handoff: string) => [
    "pin",
    "add",
    handoffRecord(id, handoff),
    "--session",
    session,
    "--json",
  ],
  attemptSubmission: (session: string, id: string, fingerprint: string, nonce: string) => [
    "pin",
    "add",
    attemptRecord(id, fingerprint, nonce),
    "--session",
    session,
    "--json",
  ],
  releaseSubmission: (session: string, id: string, nonce: string) => [
    "pin",
    "add",
    releaseRecord(id, nonce),
    "--session",
    session,
    "--json",
  ],
  findSubmission: (id: string) => [
    "find",
    `"${submissionMarker(id)}"`,
    "--kind",
    "handoff",
    "--json",
  ],
  cloudOffer: (
    input: AgentdCloudTaskInput,
    project: string,
    submission: string,
    fingerprint: string,
  ) => [
    "handoff",
    "offer",
    "--cloud",
    "--idem",
    submission,
    "--state",
    offerState(submission, fingerprint),
    "--to",
    "any",
    "--session",
    CLOUD_SESSION,
    "--budget",
    input.cloud.budget,
    "--model-access",
    input.cloud.modelAccess,
    ...(input.cloud.modelAccess === "byok" && input.cloud.anthropicKeyFile !== undefined
      ? ["--anthropic-key-file", text("Anthropic key file", input.cloud.anthropicKeyFile)]
      : []),
    ...(input.cloud.modelAccess === "byok" && input.cloud.openaiKeyFile !== undefined
      ? ["--openai-key-file", text("OpenAI key file", input.cloud.openaiKeyFile)]
      : []),
    ...subscriptionFile(input.cloud),
    "--project",
    project,
    "--goal",
    text("goal", input.goal),
    ...input.accept.flatMap((line, index) => [
      "--accept",
      text(`acceptance line ${index + 1}`, line),
    ]),
    ...(input.check === null ? ["--no-check"] : ["--check", text("check", input.check)]),
    "--json",
  ],
  enrolWorker: (server: string) => [
    "worker",
    "--server",
    agentdServerUrl(server),
    "--ticket-file",
    "-",
  ],
  foreground: (minutes: number) => ["worker", "foreground", "on", "--for", `${minutes}m`],
  eula: () => ["eula"],
  initHelp: () => ["init", "--help"],
  // Run in the home folder, so init registers no repository; the flag once agentd has one.
  init: (acceptFlag: boolean) => [
    "init",
    "--route",
    "on",
    ...(acceptFlag ? ["--accept-eula"] : []),
  ],
} as const;
