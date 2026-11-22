import {
  type CustomGatewayFormat,
  type CustomModelSetting,
  LIBRAOS_GATEWAY_INSTANCE_IDS,
  LIBRAOS_GATEWAY_ORIGIN,
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelEntry,
  type LibraosGatewayModel,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// What a connected Gateway key turns into: one provider instance per agent whose environment and
// arguments reach api.libraos.com for that instance's sessions alone. Choosing the instance in the
// model picker is choosing the Gateway; the agent's own instance keeps its own login and config.

const KEY_PREFIX = "lk_";
const KEY_SHAPE = /^lk_[A-Za-z0-9_-]{8,512}$/;
/** Codex reads the key from this variable of its own process (`model_providers.*.env_key`). */
const KEY_ENV = "LIBRAOS_API_KEY";
const PROVIDER_ID = "libraos";
const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";
const DISPLAY_SUFFIX = "LibraOS Gateway";
/** The connected key in the server's secret store. */
export const GATEWAY_KEY_SECRET = "libraos-gateway-key";

export const GATEWAY_INSTANCE_IDS = {
  claude: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.claude),
  codex: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.codex),
  opencode: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.opencode),
  pi: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.pi),
} as const;

/** A trimmed key of the shape Console issues, or why it is not one. */
export function readGatewayKey(raw: string): { key: string } | { problem: string } {
  const key = raw.trim();
  if (!key.startsWith(KEY_PREFIX)) {
    return { problem: "A LibraOS API key starts with lk_. Copy it from Console's API keys page." };
  }
  if (!KEY_SHAPE.test(key)) return { problem: "That does not look like a whole LibraOS API key." };
  return { key };
}

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      type: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
// Models a gateway marks as making media or vectors; an agent cannot chat with them.
const NOT_CHAT_TYPES = new Set(["video", "audio", "image", "embedding", "embeddings", "rerank"]);
const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeModelList = Schema.decodeUnknownOption(ModelList);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export function parseGatewayModels(body: unknown): ReadonlyArray<LibraosGatewayModel> | null {
  const list = decodeModelList(body);
  if (Option.isNone(list)) return null;
  return list.value.data
    .filter((model) => model.id.trim() !== "" && !NOT_CHAT_TYPES.has(model.type ?? ""))
    .map((model) => (model.name ? { id: model.id, name: model.name } : { id: model.id }));
}

const REFUSAL_LIMIT = 200;
// Clients that may only read status see this text, so a credential the Gateway echoes goes.
const CREDENTIAL = /\b(?:lk|sk)[_-][A-Za-z0-9_-]{6,}|\bBearer\s+\S+/gi;

/** The gateway's one-line reason for a refused request, else its status. */
export function gatewayRefusal(
  status: number,
  body: unknown,
  gateway: { readonly name: string; readonly key?: string } = { name: DISPLAY_SUFFIX },
): string {
  const parsed = decodeErrorBody(body);
  const line = Option.isSome(parsed)
    ? (parsed.value.error.message.trim().split(/\r?\n/)[0] ?? "")
    : "";
  const message = redactGatewayText(line, gateway.key);
  if (message === "") return `${gateway.name} answered HTTP ${status}.`;
  return message.length > REFUSAL_LIMIT ? `${message.slice(0, REFUSAL_LIMIT - 1)}…` : message;
}

/** Gateway text without `key` or anything shaped like a credential. */
export function redactGatewayText(text: string, key?: string | null): string {
  // A custom gateway's key has no known shape, so the key itself goes too.
  const trimmed = key?.trim();
  return (trimmed ? text.split(trimmed).join("[redacted]") : text)
    .replace(CREDENTIAL, "[redacted]")
    .trim();
}

/** A key the Gateway will not serve at all, as opposed to a Gateway that is down or busy. */
export const isKeyRefusal = (status: number): boolean => status === 401 || status === 403;

const ownName = (id: string, family: string) => {
  const [owner = "", name = "", ...rest] = id.split("/");
  return owner === family && name !== "" && rest.length === 0 ? name : undefined;
};

// Claude Code swaps these for a model of its own (case-insensitively; `default` is its default
// model); the adapter pins only the four lowercase family aliases back to themselves
// (`compileClaudeModelSelection`).
const CLAUDE_CODE_PINNED_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const CLAUDE_CODE_REWRITES = /^(?:default|best|opusplan|opus|sonnet|haiku|fable)$|\[1m\]$/i;
const claudeCodeSendsAsIs = (slug: string) =>
  CLAUDE_CODE_PINNED_ALIASES.has(slug) || !CLAUDE_CODE_REWRITES.test(slug);
// Claude Code otherwise remaps old Opus ids (`claude-opus-4-1`) to its current Opus, and moves a
// Claude model the Gateway calls unavailable down to an older one.
const CLAUDE_CODE_KEEP_MODEL = [
  "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP",
  "CLAUDE_CODE_NO_MODEL_FALLBACK",
];

/** The keep-model flags any Claude Code process sending to the Gateway gets, however configured. */
export function gatewayClaudeEnvironment(baseUrl: string | undefined): Record<string, string> {
  if (URL.parse(baseUrl?.trim() ?? "")?.origin !== LIBRAOS_GATEWAY_ORIGIN) return {};
  return Object.fromEntries(CLAUDE_CODE_KEEP_MODEL.map((name) => [name, "1"]));
}

// The agent's own family drops its prefix (agentd's workers ask so) to keep its catalog options,
// and its full id is a row too, with the same options; a bare id equal to that name is the bare
// row's request. A slug depends on its id alone, so saved choices survive key changes. Other models
// keep their full id, their family and none of the agent's options (Codex would lend a GPT model's).
export function gatewayAgentModels(models: ReadonlyArray<LibraosGatewayModel>, family: string) {
  // An id the agent would send as another model is not offered, or kept whole when that avoids it.
  const sendsAsIs = family === "anthropic" ? claudeCodeSendsAsIs : () => true;
  const own = (id: string) => {
    const name = ownName(id, family);
    return name !== undefined && sendsAsIs(name) ? name : undefined;
  };
  const ownNames = new Set(models.flatMap((model) => own(model.id) ?? []));
  const ownModels: Array<CustomModelEntry> = [];
  const ownFullIds: Array<CustomModelEntry> = [];
  const other: Array<CustomModelEntry> = [];
  for (const model of models) {
    const named = model.name ? { name: model.name } : {};
    const name = own(model.id);
    if (name !== undefined) {
      ownModels.push({ slug: name, ...named });
      // No options here: the snapshot and Claude's runtime catalog give it those of `name`.
      ownFullIds.push({ slug: model.id, ...named, subProvider: family });
      continue;
    }
    if (ownNames.has(model.id) || !sendsAsIs(model.id)) continue;
    const owner = model.id.split("/")[0] ?? "";
    other.push({
      slug: model.id,
      ...named,
      ...(owner !== "" && model.id.includes("/") ? { subProvider: owner } : {}),
      capabilities: { optionDescriptors: [] },
    });
  }
  return [...ownModels, ...ownFullIds, ...other];
}

const tomlString = (value: string) => JSON.stringify(value);
// Single quotes keep each `-c key="value"` one argument through the launch-argument tokenizer.
const codexConfigArg = (key: string, value: string) => `-c '${key}=${tomlString(value)}'`;

type GatewayAgent = "claude" | "codex";

/** Where a gateway's instances point and how they authenticate; one per gateway. */
interface GatewayShape extends PiGatewayTarget {
  readonly ids: Readonly<Record<GatewayAgent | "opencode" | "pi", ProviderInstanceId>>;
  /** The provider id in Codex's and opencode's config. */
  readonly providerId: string;
  readonly name: string;
  /** Claude Code's `ANTHROPIC_BASE_URL`, without `/v1`. */
  readonly origin: string;
  /** Codex's and opencode's base URL, ending in `/v1`. */
  readonly base: string;
  /** The variable Codex and opencode read the key from; null when the gateway takes none. */
  readonly keyEnv: string | null;
  readonly opencodeNpm: string;
  /** The agents besides opencode and Pi that speak the gateway's format. */
  readonly agents: ReadonlyArray<GatewayAgent>;
  /** Pi speaks the gateway's format (OpenAI's). */
  readonly pi: boolean;
  /** A rename rewrites the provider name inside opencode's config. */
  readonly renamable: boolean;
  /** Variables set to "1" for Claude Code, added to agents connected before they existed. */
  readonly claudeEnvironment: ReadonlyArray<string>;
  readonly agentModels: (
    models: ReadonlyArray<LibraosGatewayModel>,
    agent: GatewayAgent,
  ) => ReadonlyArray<CustomModelSetting>;
}

const LIBRAOS_SHAPE: GatewayShape = {
  ids: GATEWAY_INSTANCE_IDS,
  providerId: PROVIDER_ID,
  name: DISPLAY_SUFFIX,
  origin: LIBRAOS_GATEWAY_ORIGIN,
  base: `${LIBRAOS_GATEWAY_ORIGIN}/v1`,
  keyEnv: KEY_ENV,
  opencodeNpm: "@ai-sdk/openai-compatible",
  agents: ["claude", "codex"],
  pi: true,
  renamable: false,
  claudeEnvironment: CLAUDE_CODE_KEEP_MODEL,
  // Every key model runs on both agents, by the rules of `gatewayAgentModels`.
  agentModels: (models, agent) =>
    gatewayAgentModels(models, agent === "claude" ? "anthropic" : "openai"),
};

function codexLaunchArgs(shape: GatewayShape): string {
  const prefix = `model_providers.${shape.providerId}`;
  return [
    codexConfigArg("model_provider", shape.providerId),
    codexConfigArg(`${prefix}.name`, shape.name),
    codexConfigArg(`${prefix}.base_url`, shape.base),
    ...(shape.keyEnv === null ? [] : [codexConfigArg(`${prefix}.env_key`, shape.keyEnv)]),
    codexConfigArg(`${prefix}.wire_api`, "responses"),
  ].join(" ");
}

export const codexGatewayLaunchArgs = (): string => codexLaunchArgs(LIBRAOS_SHAPE);

/** opencode's inline config: the gateway as its only provider, the key read from the env. */
function opencodeGatewayConfig(
  shape: GatewayShape,
  models: ReadonlyArray<LibraosGatewayModel>,
): string {
  const first = models.find((model) => model.id.startsWith("anthropic/")) ?? models[0];
  return JSON.stringify({
    enabled_providers: [shape.providerId],
    ...(first ? { model: `${shape.providerId}/${first.id}` } : {}),
    provider: {
      [shape.providerId]: {
        npm: shape.opencodeNpm,
        name: shape.name,
        options: {
          baseURL: shape.base,
          ...(shape.keyEnv === null ? {} : { apiKey: `{env:${shape.keyEnv}}` }),
        },
        models: Object.fromEntries(
          models.map((model) => [model.id, model.name ? { name: model.name } : {}]),
        ),
      },
    },
  });
}

/** Where Pi sends a gateway's requests: its own provider in models.json, the only one there. */
export interface PiGatewayTarget {
  readonly providerId: string;
  /** Ending in `/v1`. */
  readonly base: string;
  /** The variable the key is read from; null when the gateway takes none. */
  readonly keyEnv: string | null;
}

/** Pi reads models.json and settings.json from here instead of ~/.pi/agent. */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Pi's slug for a gateway model is `<provider>/<id>`; listing them shows a refresh at once. */
const piGatewayModels = (target: PiGatewayTarget, models: ReadonlyArray<LibraosGatewayModel>) =>
  models.map((model) => ({
    slug: `${target.providerId}/${model.id}`,
    ...(model.name ? { name: model.name } : {}),
  }));

/**
 * The files of a gateway's Pi agent directory. models.json names the key's variable, never the
 * key. settings.json keeps what Pi wrote there and points its default model at the gateway's when
 * the one it has is gone.
 */
export function piGatewayFiles(
  target: PiGatewayTarget,
  models: ReadonlyArray<LibraosGatewayModel>,
  currentSettings: string | undefined,
): { readonly models: string; readonly settings: string } {
  const modelsJson = {
    providers: {
      [target.providerId]: {
        baseUrl: target.base,
        api: "openai-completions",
        // Pi will not use a provider without a key; a keyless gateway ignores this one.
        apiKey: target.keyEnv === null ? "none" : `$${target.keyEnv}`,
        models: models.map((model) => ({
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
        })),
      },
    },
  };
  let parsed: unknown;
  try {
    parsed = currentSettings === undefined ? undefined : JSON.parse(currentSettings);
  } catch {
    parsed = undefined;
  }
  const settings: Record<string, unknown> = isRecord(parsed) ? { ...parsed } : {};
  const kept =
    settings.defaultProvider === target.providerId &&
    models.some((model) => model.id === settings.defaultModel);
  const first = models.find((model) => model.id.startsWith("anthropic/")) ?? models[0];
  if (!kept && first !== undefined) {
    settings.defaultProvider = target.providerId;
    settings.defaultModel = first.id;
  }
  return {
    models: `${JSON.stringify(modelsJson, null, 2)}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
  };
}

export const LIBRAOS_PI_TARGET: PiGatewayTarget = {
  providerId: PROVIDER_ID,
  base: `${LIBRAOS_GATEWAY_ORIGIN}/v1`,
  keyEnv: KEY_ENV,
};

const secret = (name: string, value: string) => ({ name, value, sensitive: true });
const plain = (name: string, value: string) => ({ name, value, sensitive: false });

type GatewayInstances = ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}>;

function shapeInstances(
  shape: GatewayShape,
  key: string | null,
  models: ReadonlyArray<LibraosGatewayModel>,
  piAgentDir: string,
): GatewayInstances {
  const keyVariable = shape.keyEnv !== null && key !== null ? [secret(shape.keyEnv, key)] : [];
  const agents: Record<GatewayAgent, ProviderInstanceConfig> = {
    claude: {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: `Claude Code · ${shape.name}`,
      enabled: true,
      environment: [
        plain("ANTHROPIC_BASE_URL", shape.origin),
        ...(key === null ? [] : [secret("ANTHROPIC_API_KEY", key)]),
        ...shape.claudeEnvironment.map((name) => plain(name, "1")),
      ],
      // The gateway's models replace Claude's catalog: any other model would fail there.
      config: { customModels: shape.agentModels(models, "claude"), onlyCustomModels: true },
    },
    codex: {
      driver: ProviderDriverKind.make("codex"),
      displayName: `Codex · ${shape.name}`,
      enabled: true,
      environment: keyVariable,
      config: {
        setupMode: "existing",
        launchArgs: codexLaunchArgs(shape),
        customModels: shape.agentModels(models, "codex"),
        onlyCustomModels: true,
      },
    },
  };
  return [
    ...shape.agents.map((agent) => ({ instanceId: shape.ids[agent], instance: agents[agent] })),
    {
      instanceId: shape.ids.opencode,
      instance: {
        driver: ProviderDriverKind.make("opencode"),
        displayName: `opencode · ${shape.name}`,
        enabled: true,
        environment: [
          ...keyVariable,
          plain(OPENCODE_CONFIG_ENV, opencodeGatewayConfig(shape, models)),
        ],
        config: { enabled: true },
      },
    },
    ...(shape.pi
      ? [
          {
            instanceId: shape.ids.pi,
            instance: {
              driver: ProviderDriverKind.make("pi"),
              displayName: `Pi · ${shape.name}`,
              enabled: true,
              environment: [...keyVariable, plain(PI_AGENT_DIR_ENV, piAgentDir)],
              config: { customModels: piGatewayModels(shape, models) },
            },
          },
        ]
      : []),
  ];
}

/** `piAgentDir` is the directory the server keeps for the Pi agent's models.json. */
export const gatewayProviderInstances = (
  key: string,
  models: ReadonlyArray<LibraosGatewayModel>,
  piAgentDir: string,
): GatewayInstances => shapeInstances(LIBRAOS_SHAPE, key, models, piAgentDir);

const CUSTOM_KEY_ENV = "CUSTOM_GATEWAY_API_KEY";
const CUSTOM_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 8 characters of [a-z0-9]: a valid instance slug as `gw-<id>-…` and a bare TOML key as `gw_<id>`. */
export function newCustomGatewayId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => CUSTOM_ID_ALPHABET[byte % CUSTOM_ID_ALPHABET.length]).join("");
}

/** The custom gateway's key in the server's secret store. */
export const customGatewayKeySecret = (id: string) => `custom-gateway-key-${id}`;

export const customGatewayInstanceIds = (id: string) => ({
  claude: ProviderInstanceId.make(`gw-${id}-claude`),
  codex: ProviderInstanceId.make(`gw-${id}-codex`),
  opencode: ProviderInstanceId.make(`gw-${id}-opencode`),
  pi: ProviderInstanceId.make(`gw-${id}-pi`),
});

/** The URL as entered without trailing slashes, which is also the name a gateway gets by default. */
export const trimGatewayUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export interface CustomGatewayInput {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly format: CustomGatewayFormat;
  readonly key: string | null;
}

function customShape(gateway: Omit<CustomGatewayInput, "key">, hasKey: boolean): GatewayShape {
  const url = trimGatewayUrl(gateway.url);
  const origin = url.replace(/\/v1$/, "");
  return {
    ids: customGatewayInstanceIds(gateway.id),
    providerId: `gw_${gateway.id}`,
    name: gateway.name,
    origin,
    base: `${origin}/v1`,
    keyEnv: hasKey ? CUSTOM_KEY_ENV : null,
    opencodeNpm: gateway.format === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    agents: [gateway.format === "anthropic" ? "claude" : "codex"],
    // Pi's anthropic-messages API would serve the other format; untested, so not offered yet.
    pi: gateway.format === "openai",
    renamable: true,
    claudeEnvironment: [],
    // A custom gateway's ids are what its agents ask for, as given.
    agentModels: (models) =>
      models.map((model) => ({ slug: model.id, ...(model.name ? { name: model.name } : {}) })),
  };
}

/** The Pi target of a custom gateway, `hasKey` when it keeps a key. */
export const customPiTarget = (
  gateway: Pick<CustomGatewayInput, "id" | "url">,
  hasKey: boolean,
): PiGatewayTarget => {
  const { providerId, base, keyEnv } = customShape(
    { ...gateway, name: "", format: "openai" },
    hasKey,
  );
  return { providerId, base, keyEnv };
};

const GATEWAY_ACCENT_COLORS = [
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#65a30d",
] as const;

/** A color no provider has yet, so a new gateway's agents stand apart; the least used once all are taken. */
export function nextGatewayAccentColor(current: ProviderInstanceConfigMap): string {
  const uses = (color: string) =>
    Object.values(current).filter((instance) => instance.accentColor?.toLowerCase() === color)
      .length;
  return GATEWAY_ACCENT_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

export const customGatewayInstances = (
  gateway: CustomGatewayInput & {
    readonly models: ReadonlyArray<LibraosGatewayModel>;
    readonly piAgentDir: string;
  },
): GatewayInstances =>
  shapeInstances(
    customShape(gateway, gateway.key !== null),
    gateway.key,
    gateway.models,
    gateway.piAgentDir,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The inline config with only the Gateway provider's models, and a default it lost, replaced. */
function patchOpencodeGatewayConfig(
  shape: GatewayShape,
  current: string | undefined,
  models: ReadonlyArray<LibraosGatewayModel>,
): string {
  const fresh = opencodeGatewayConfig(shape, models);
  let parsed: unknown;
  try {
    parsed = current === undefined ? undefined : JSON.parse(current);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) return fresh;
  const served = JSON.parse(fresh) as { model?: string };
  const providers = isRecord(parsed.provider) ? parsed.provider : {};
  const ownEntry = providers[shape.providerId];
  const own = isRecord(ownEntry) ? ownEntry : {};
  const ownModels = isRecord(own.models) ? own.models : {};
  const next: Record<string, unknown> = { ...parsed };
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  const lost =
    model === undefined ||
    (model.startsWith(`${shape.providerId}/`) &&
      !models.some((entry) => `${shape.providerId}/${entry.id}` === model));
  if (lost) {
    if (served.model === undefined) delete next.model;
    else next.model = served.model;
  }
  next.provider = {
    ...providers,
    [shape.providerId]: {
      ...own,
      // A rename reaches opencode's own provider name; LibraOS Gateway's is its user's to edit.
      ...(shape.renamable ? { name: shape.name } : {}),
      models: Object.fromEntries(
        models.map((entry) => [
          entry.id,
          ownModels[entry.id] ?? (entry.name ? { name: entry.name } : {}),
        ]),
      ),
    },
  };
  return JSON.stringify(next);
}

/** The key the opencode Gateway agent sends, when it is not `connected` (settings with secrets). */
export function opencodeOwnGatewayKey(
  current: ProviderInstanceConfigMap,
  connected: string,
): string | undefined {
  const value = current[GATEWAY_INSTANCE_IDS.opencode]?.environment?.find(
    (variable) => variable.name === KEY_ENV,
  )?.value;
  const key = typeof value === "string" ? value.trim() : undefined;
  return key && key !== connected ? key : undefined;
}

/**
 * Only the Gateway agents' model lists change; `models: null` (not asked yet) keeps them and marks
 * Claude and Codex limited to them. opencode keeps its list in its config, so it takes the list of
 * the key it sends as `opencodeModels`. Returns `current` itself when nothing changes.
 */
export const withGatewayModels = (
  current: ProviderInstanceConfigMap,
  models: ReadonlyArray<LibraosGatewayModel> | null,
  opencodeModels: ReadonlyArray<LibraosGatewayModel> | null = models,
): ProviderInstanceConfigMap => withShapeModels(LIBRAOS_SHAPE, current, models, opencodeModels);

/** The model list a custom gateway's agents have now, null without any agent. */
export function customGatewayModels(
  current: ProviderInstanceConfigMap,
  id: string,
): ReadonlyArray<LibraosGatewayModel> | null {
  const ids = customGatewayInstanceIds(id);
  for (const instanceId of [ids.codex, ids.claude]) {
    const config = current[instanceId]?.config;
    if (!isRecord(config) || !Array.isArray(config.customModels)) continue;
    return config.customModels.flatMap((model: unknown) =>
      isRecord(model) && typeof model.slug === "string"
        ? [{ id: model.slug, ...(typeof model.name === "string" ? { name: model.name } : {}) }]
        : [],
    );
  }
  // Pi's slugs carry its provider id in front of the gateway's.
  const pi = current[ids.pi]?.config;
  if (isRecord(pi) && Array.isArray(pi.customModels)) {
    const prefix = `gw_${id}/`;
    return pi.customModels.flatMap((model: unknown) =>
      isRecord(model) && typeof model.slug === "string" && model.slug.startsWith(prefix)
        ? [
            {
              id: model.slug.slice(prefix.length),
              ...(typeof model.name === "string" ? { name: model.name } : {}),
            },
          ]
        : [],
    );
  }
  // A gateway with opencode alone keeps its list in opencode's inline config.
  const inline = current[ids.opencode]?.environment?.find(
    (variable) => variable.name === OPENCODE_CONFIG_ENV,
  )?.value;
  if (typeof inline !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(inline);
    const provider =
      isRecord(parsed) && isRecord(parsed.provider) ? parsed.provider[`gw_${id}`] : null;
    const models = isRecord(provider) && isRecord(provider.models) ? provider.models : null;
    return models === null ? null : Object.keys(models).map((model) => ({ id: model }));
  } catch {
    return null;
  }
}

/** A custom gateway's agents given its current name and model list, `current` when unchanged. */
export function withCustomGateway(
  current: ProviderInstanceConfigMap,
  gateway: Omit<CustomGatewayInput, "key">,
  models: ReadonlyArray<LibraosGatewayModel> | null,
): ProviderInstanceConfigMap {
  const ids = customGatewayInstanceIds(gateway.id);
  const codex = current[ids.codex];
  const hasKey = [ids.codex, ids.opencode, ids.pi].some((id) =>
    current[id]?.environment?.some((variable) => variable.name === CUSTOM_KEY_ENV),
  );
  const shape = customShape(gateway, hasKey);
  const named: Record<string, ProviderInstanceConfig> = { ...current };
  for (const [agent, label] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["opencode", "opencode"],
    ["pi", "Pi"],
  ] as const) {
    const existing = current[ids[agent]];
    if (existing !== undefined)
      named[ids[agent]] = { ...existing, displayName: `${label} · ${gateway.name}` };
  }
  // A gateway added before its agents had a color gets one now.
  const own = Object.values(ids).filter((id) => named[id] !== undefined);
  if (own.length > 0 && own.every((id) => named[id]!.accentColor === undefined)) {
    const accentColor = nextGatewayAccentColor(current);
    for (const id of own) named[id] = { ...named[id]!, accentColor };
  }
  if (codex !== undefined) {
    const config = isRecord(codex.config) ? codex.config : {};
    named[ids.codex] = {
      ...named[ids.codex]!,
      config: { ...config, launchArgs: codexLaunchArgs(shape) },
    };
  }
  const list = models ?? customGatewayModels(current, gateway.id);
  const next = withShapeModels(shape, named, list, list);
  return JSON.stringify(next) === JSON.stringify(current) ? current : next;
}

/**
 * Only the gateway agents' model lists change; `models: null` (not asked yet) keeps them and marks
 * Claude and Codex limited to them. opencode keeps its list in its config, so it takes the list of
 * the key it sends as `opencodeModels`. Returns `current` itself when nothing changes.
 */
function withShapeModels(
  shape: GatewayShape,
  current: ProviderInstanceConfigMap,
  models: ReadonlyArray<LibraosGatewayModel> | null,
  opencodeModels: ReadonlyArray<LibraosGatewayModel> | null,
): ProviderInstanceConfigMap {
  const next: Record<string, ProviderInstanceConfig> = { ...current };
  let changed = false;
  const set = (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
    if (JSON.stringify(instance) === JSON.stringify(current[instanceId])) return;
    next[instanceId] = instance;
    changed = true;
  };
  for (const agent of ["claude", "codex"] as const) {
    const instanceId = shape.ids[agent];
    const existing = current[instanceId];
    if (existing === undefined) continue;
    const config = isRecord(existing.config) ? existing.config : {};
    const environment = existing.environment ?? [];
    // Claude agents connected before these variables existed get them too.
    const missing =
      agent === "claude"
        ? shape.claudeEnvironment.filter(
            (name) => !environment.some((variable) => variable.name === name),
          )
        : [];
    set(instanceId, {
      ...existing,
      ...(missing.length > 0
        ? { environment: [...environment, ...missing.map((name) => plain(name, "1"))] }
        : {}),
      config: {
        ...config,
        ...(models === null ? {} : { customModels: shape.agentModels(models, agent) }),
        onlyCustomModels: true,
      },
    });
  }
  const opencode = current[shape.ids.opencode];
  if (opencode !== undefined) {
    const config = isRecord(opencode.config) ? opencode.config : {};
    const environment = opencode.environment ?? [];
    const existing = environment.find((variable) => variable.name === OPENCODE_CONFIG_ENV)?.value;
    const value =
      opencodeModels === null
        ? null
        : patchOpencodeGatewayConfig(
            shape,
            typeof existing === "string" ? existing : undefined,
            opencodeModels,
          );
    set(shape.ids.opencode, {
      ...opencode,
      // Its models live in OPENCODE_CONFIG_CONTENT; an older build let users add custom ones.
      ...(Array.isArray(config.customModels) && config.customModels.length > 0
        ? { config: { ...config, customModels: [] } }
        : {}),
      ...(value === null
        ? {}
        : {
            environment: environment.some((variable) => variable.name === OPENCODE_CONFIG_ENV)
              ? environment.map((variable) =>
                  variable.name === OPENCODE_CONFIG_ENV ? { ...variable, value } : variable,
                )
              : [...environment, plain(OPENCODE_CONFIG_ENV, value)],
          }),
    });
  }
  const pi = current[shape.ids.pi];
  if (pi !== undefined && models !== null) {
    const config = isRecord(pi.config) ? pi.config : {};
    set(shape.ids.pi, {
      ...pi,
      config: { ...config, customModels: piGatewayModels(shape, models) },
    });
  }
  return changed ? next : current;
}
