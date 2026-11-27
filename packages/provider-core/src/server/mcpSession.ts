import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
  /** Servers that plugins on in the thread's project add, by name; read at each launch. */
  readonly pluginMcpServers?: Effect.Effect<Readonly<Record<string, PluginMcpServer>>>;
  /** Claude plugin folders on in the thread's project, which Claude loads itself; read at each launch. */
  readonly claudePlugins?: Effect.Effect<ReadonlyArray<ClaudePluginFolder>>;
  /** Plugin skills, for an agent that loads skill folders itself (Codex); read at each launch. */
  readonly pluginSkills?: Effect.Effect<PluginSkills>;
}

export interface PluginSkills {
  /** The `skills` folder of every installed plugin, the same for every project. */
  readonly roots: ReadonlyArray<string>;
  /** The SKILL.md files in `roots` of the plugins not on in the thread's project. */
  readonly off: ReadonlyArray<string>;
}

export interface ClaudePluginFolder {
  readonly path: string;
  /** The plugin's name in its `plugin.json`. */
  readonly name: string;
  /** Its userConfig options' values; a secret one is the path of the file holding it. */
  readonly options: Readonly<Record<string, string>>;
  /** Its servers that arrive in `pluginMcpServers`, which Claude must not start a second time. */
  readonly ownServers: ReadonlyArray<string>;
}

export interface McpStdioServer {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface McpHttpServer {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type PluginMcpServer = McpStdioServer | McpHttpServer;

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
