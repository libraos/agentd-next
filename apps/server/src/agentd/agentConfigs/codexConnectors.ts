import {
  type AgentdConnector,
  type AgentdConnectorServer,
  AgentdCustomizeError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

// Codex's connectors as its app-server reports them, every layer merged and each key's origin
// named. Writes go back through the app-server to the user's config.toml, against the version
// that was read, so a save Codex made meanwhile is never overwritten.

/** The two app-server calls connectors make; tests stand in for Codex here. */
export interface CodexConfigApi {
  readonly read: (
    cwd: string | null,
  ) => Effect.Effect<CodexSchema.V2ConfigReadResponse, CodexErrors.CodexAppServerError>;
  readonly write: (
    params: CodexSchema.V2ConfigBatchWriteParams,
  ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
}

/** Codex's rows and the user config's version a write must still find. */
export interface CodexListing {
  readonly connectors: ReadonlyArray<AgentdConnector>;
  readonly userVersion: string | undefined;
}

type Json = Record<string, unknown>;
type Source = CodexSchema.V2ConfigReadResponse__ConfigLayerSource;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectOr = (value: unknown): Json => (isObject(value) ? value : {});
const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const keysOf = (value: unknown) => Object.keys(objectOr(value));
const unique = (names: ReadonlyArray<string>) => [...new Set(names)].toSorted();

const scopeOf = (source: Source | undefined): AgentdConnector["scope"] =>
  source?.type === "user" ? "user" : source?.type === "project" ? "project" : "managed";

const fileOf = (source: Source | undefined, join: (...parts: Array<string>) => string) =>
  source === undefined
    ? undefined
    : "file" in source
      ? source.file
      : "dotCodexFolder" in source
        ? join(source.dotCodexFolder, "config.toml")
        : undefined;

/** A server of Codex's merged config as a row: names of its env vars and headers, no values. */
function codexConnector(
  name: string,
  raw: unknown,
  place: Pick<AgentdConnector, "scope" | "enabled" | "toggle" | "removable"> & {
    readonly file: string | undefined;
    readonly problem: string | undefined;
  },
): AgentdConnector {
  const { file, problem, ...rest } = place;
  const server = objectOr(raw);
  const remote = typeof server.url === "string";
  const envNames = unique([
    ...keysOf(server.env),
    ...stringsOf(server.env_vars),
    ...(typeof server.bearer_token_env_var === "string" ? [server.bearer_token_env_var] : []),
    ...Object.values(objectOr(server.env_http_headers)).filter(
      (value): value is string => typeof value === "string",
    ),
  ]);
  const headerNames = unique([...keysOf(server.http_headers), ...keysOf(server.env_http_headers)]);
  const shown =
    problem ??
    (remote || typeof server.command === "string" ? undefined : "It has no command or URL.");
  return {
    name,
    ...rest,
    transport: remote ? "http" : "stdio",
    ...(remote ? { url: server.url as string } : {}),
    ...(typeof server.command === "string" ? { command: server.command } : {}),
    ...(remote ? {} : { args: stringsOf(server.args) }),
    envNames,
    headerNames,
    ...(file === undefined ? {} : { file }),
    ...(shown === undefined ? {} : { problem: shown }),
  };
}

/** Rows of a config/read with layers: the merged servers, and those of a project Codex ignores. */
function codexRows(
  read: CodexSchema.V2ConfigReadResponse,
  join: (...parts: Array<string>) => string,
): CodexListing {
  const servers = objectOr((read.config as Json).mcp_servers);
  const origin = (key: string) => read.origins[key]?.name;
  const connectors: Array<AgentdConnector> = [];
  for (const [name, raw] of Object.entries(servers).toSorted(([a], [b]) => a.localeCompare(b))) {
    const prefix = `mcp_servers.${name}.`;
    const declared =
      origin(`${prefix}command`) ??
      origin(`${prefix}url`) ??
      Object.entries(read.origins).find(([key]) => key.startsWith(prefix))?.[1].name;
    const scope = scopeOf(declared);
    const switchedElsewhere = (origin(`${prefix}enabled`)?.type ?? "user") !== "user";
    const dotted = name.includes(".");
    const toggle = scope === "user" && !dotted && !switchedElsewhere ? "user" : "none";
    connectors.push(
      codexConnector(name, raw, {
        scope,
        enabled: objectOr(raw).enabled !== false,
        toggle,
        removable: scope === "user" && !dotted,
        file: fileOf(declared, join),
        problem: dotted
          ? "Its name has a dot, which this app can’t write to Codex’s config."
          : scope === "user" && switchedElsewhere
            ? "Switched in another of Codex’s config files."
            : declared?.type === "sessionFlags"
              ? "Set by this agent’s launch arguments in its settings."
              : undefined,
      }),
    );
  }
  for (const layer of read.layers ?? []) {
    if (layer.name.type !== "project" || !layer.disabledReason) continue;
    const ignored = objectOr(objectOr(layer.config).mcp_servers);
    for (const [name, raw] of Object.entries(ignored).toSorted(([a], [b]) => a.localeCompare(b))) {
      if (name in servers) continue;
      connectors.push(
        codexConnector(name, raw, {
          scope: "project",
          enabled: false,
          toggle: "none",
          removable: false,
          file: fileOf(layer.name, join),
          problem: layer.disabledReason,
        }),
      );
    }
  }
  const userVersion = (read.layers ?? []).find((layer) => layer.name.type === "user")?.version;
  return { connectors, userVersion };
}

/** The table Codex keeps for a server the person typed. */
const codexServerTable = (server: AgentdConnectorServer) =>
  server.transport === "stdio"
    ? {
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      }
    : {
        url: server.url,
        ...(Object.keys(server.headers).length > 0 ? { http_headers: { ...server.headers } } : {}),
      };

const redact = (message: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce(
    (text, secret) => (secret.length > 0 ? text.replaceAll(secret, "…") : text),
    message,
  );

const writeFailed = (secrets: ReadonlyArray<string>) => (error: CodexErrors.CodexAppServerError) =>
  error._tag === "CodexAppServerRequestError" &&
  objectOr(error.data).config_write_error_code === "configVersionConflict"
    ? new AgentdCustomizeError({
        reason: "changed",
        message: "Codex’s config changed while it was being written. Try again.",
      })
    : new AgentdCustomizeError({
        reason: "failed",
        message:
          error._tag === "CodexAppServerRequestError"
            ? `Codex refused the change: ${redact(error.message, secrets)}`
            : "Codex couldn’t be reached to make the change.",
      });

export const makeCodexConnectors = (path: {
  readonly join: (...parts: Array<string>) => string;
}) => {
  const list = Effect.fn("CodexConnectors.list")(function* (
    api: CodexConfigApi,
    cwd: string | null,
  ) {
    const read = yield* api.read(cwd).pipe(
      Effect.mapError(
        (error) =>
          new AgentdCustomizeError({
            reason: "failed",
            message:
              error._tag === "CodexAppServerRequestError"
                ? `Codex couldn’t read its config: ${error.message}`
                : "Codex couldn’t be started to read its config.",
          }),
      ),
    );
    return codexRows(read, path.join);
  });

  const write = (
    api: CodexConfigApi,
    keyPath: string,
    value: CodexSchema.V2ConfigBatchWriteParams__ConfigEdit["value"],
    userVersion: string | undefined,
    secrets: ReadonlyArray<string> = [],
  ) =>
    api
      .write({
        edits: [{ keyPath, value, mergeStrategy: "replace" }],
        ...(userVersion === undefined ? {} : { expectedVersion: userVersion }),
        reloadUserConfig: true,
      })
      .pipe(Effect.asVoid, Effect.mapError(writeFailed(secrets)));

  const setEnabled = Effect.fn("CodexConnectors.setEnabled")(function* (
    api: CodexConfigApi,
    name: string,
    enabled: boolean,
    userVersion: string | undefined,
  ) {
    yield* write(api, `mcp_servers.${name}.enabled`, enabled, userVersion);
  });

  const add = Effect.fn("CodexConnectors.add")(function* (
    api: CodexConfigApi,
    name: string,
    server: AgentdConnectorServer,
    userVersion: string | undefined,
  ) {
    const secrets = Object.values(server.transport === "stdio" ? server.env : server.headers);
    yield* write(api, `mcp_servers.${name}`, codexServerTable(server), userVersion, secrets);
  });

  const remove = Effect.fn("CodexConnectors.remove")(function* (
    api: CodexConfigApi,
    name: string,
    userVersion: string | undefined,
  ) {
    yield* write(api, `mcp_servers.${name}`, null, userVersion);
  });

  return { list, setEnabled, add, remove };
};

export type CodexConnectors = ReturnType<typeof makeCodexConnectors>;
