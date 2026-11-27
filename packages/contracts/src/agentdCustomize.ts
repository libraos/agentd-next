import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Customize: the agents' own connectors (MCP servers) and skills, read from and written to each
// agent's own configuration. The app keeps no copy; Claude Code and Codex can change; others are listed as unsupported.

/** Where a connector is declared, which decides who may change it. */
export const AgentdConnectorScope = Schema.Literals([
  /** The agent's user configuration (Claude: ~/.claude.json; Codex: ~/.codex/config.toml). */
  "user",
  /** Claude: the project's entry in ~/.claude.json, for this person only. */
  "local",
  /** The project's own file (Claude: .mcp.json; Codex: .codex/config.toml in the project). */
  "project",
  /** A plugin the agent installed itself. */
  "plugin",
  /** A LibraOS Next plugin; changed on the Plugins pane. */
  "agentdPlugin",
  /** An administrator's managed configuration. */
  "managed",
]);
export type AgentdConnectorScope = typeof AgentdConnectorScope.Type;

/** none: cannot be switched here; project: only for the chosen project; user: for every project. */
export const AgentdCustomizeToggle = Schema.Literals(["none", "project", "user"]);
export type AgentdCustomizeToggle = typeof AgentdCustomizeToggle.Type;

/** A connector as listed: the names of its environment variables and headers, never their values. */
export const AgentdConnector = Schema.Struct({
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http", "sse"]),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  envNames: Schema.Array(Schema.String),
  headerNames: Schema.Array(Schema.String),
  scope: AgentdConnectorScope,
  /** The file it is declared in, as a path on the server. */
  file: Schema.optionalKey(Schema.String),
  /** With scope plugin or agentdPlugin: the plugin's name. */
  plugin: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  toggle: AgentdCustomizeToggle,
  /** Added by the person (user or local scope), so Remove is offered. */
  removable: Schema.Boolean,
  /** Why it cannot be used or switched, such as an entry the agent cannot read. */
  problem: Schema.optionalKey(Schema.String),
});
export type AgentdConnector = typeof AgentdConnector.Type;

/** One agent instance's connectors, or why it has none to show. */
export const AgentdCustomizeAgentConnectors = Schema.Struct({
  instanceId: ProviderInstanceId,
  supported: Schema.Boolean,
  /** When not supported, or when its configuration could not be read: why. */
  reason: Schema.optionalKey(Schema.String),
  connectors: Schema.Array(AgentdConnector),
});
export type AgentdCustomizeAgentConnectors = typeof AgentdCustomizeAgentConnectors.Type;

export const AgentdConnectorsListInput = Schema.Struct({
  /** The project whose project and local connectors are listed; none lists user ones only. */
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentdConnectorsListInput = typeof AgentdConnectorsListInput.Type;

export const AgentdConnectors = Schema.Struct({
  agents: Schema.Array(AgentdCustomizeAgentConnectors),
});
export type AgentdConnectors = typeof AgentdConnectors.Type;

export const AgentdConnectorRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: Schema.String,
  scope: AgentdConnectorScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentdConnectorRef = typeof AgentdConnectorRef.Type;

export const AgentdConnectorSetEnabledInput = Schema.Struct({
  ...AgentdConnectorRef.fields,
  enabled: Schema.Boolean,
});
export type AgentdConnectorSetEnabledInput = typeof AgentdConnectorSetEnabledInput.Type;

/** What the person typed; values are written to the agent's configuration once and never sent back. */
export const AgentdConnectorServer = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    transport: Schema.Literal("http"),
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type AgentdConnectorServer = typeof AgentdConnectorServer.Type;

export const AgentdConnectorAddInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: Schema.String,
  /** user: every project; local: Claude only, the chosen project only. */
  scope: Schema.Literals(["user", "local"]),
  projectId: Schema.optionalKey(ProjectId),
  server: AgentdConnectorServer,
});
export type AgentdConnectorAddInput = typeof AgentdConnectorAddInput.Type;

export const AgentdSkillRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The SKILL.md path the provider's skill list gave. */
  path: Schema.String,
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentdSkillRef = typeof AgentdSkillRef.Type;

export const AgentdSkillSetEnabledInput = Schema.Struct({
  ...AgentdSkillRef.fields,
  enabled: Schema.Boolean,
});
export type AgentdSkillSetEnabledInput = typeof AgentdSkillSetEnabledInput.Type;

export const AgentdSkillDetail = Schema.Struct({
  path: Schema.String,
  /** The SKILL.md text, cut at a size limit. */
  body: Schema.String,
  truncated: Schema.Boolean,
  toggle: AgentdCustomizeToggle,
  /** The file a switch writes, or the one that decides it when the switch is locked. */
  settingsFile: Schema.optionalKey(Schema.String),
  /** With toggle none: why, such as a plugin's skill that follows its plugin. */
  lockedReason: Schema.optionalKey(Schema.String),
});
export type AgentdSkillDetail = typeof AgentdSkillDetail.Type;

export const AgentdCustomizeErrorReason = Schema.Literals([
  "unsupported",
  "notFound",
  "invalid",
  "locked",
  /** The file changed while it was being written; the person tries again. */
  "changed",
  "failed",
]);
export type AgentdCustomizeErrorReason = typeof AgentdCustomizeErrorReason.Type;

export class AgentdCustomizeError extends Schema.TaggedError<AgentdCustomizeError>()(
  "AgentdCustomizeError",
  { reason: AgentdCustomizeErrorReason, message: Schema.String },
) {}
