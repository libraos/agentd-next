import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  codexGatewayLaunchArgs,
  customGatewayInstances,
  gatewayProviderInstances,
  GATEWAY_INSTANCE_IDS,
  gatewayRefusal,
  customGatewayModels,
  customPiTarget,
  LIBRAOS_PI_TARGET,
  piGatewayFiles,
  withCustomGateway,
  withGatewayModels,
} from "./gatewaySetup.ts";

// Another family's model keeps its Gateway id, sits under its family and has no agent options.
const otherFamily = (slug: string, name?: string) => ({
  slug,
  ...(name ? { name } : {}),
  subProvider: slug.split("/")[0],
  capabilities: { optionDescriptors: [] },
});

const env = (
  entry: ReturnType<typeof customGatewayInstances>[number] | undefined,
  name: string,
): string | undefined => {
  const value = entry?.instance.environment?.find((variable) => variable.name === name)?.value;
  return typeof value === "string" ? value : undefined;
};
const opencodeConfigOf = (entries: ReturnType<typeof customGatewayInstances>) =>
  JSON.parse(
    env(
      entries.find(({ instanceId }) => instanceId.endsWith("-opencode")),
      "OPENCODE_CONFIG_CONTENT",
    )!,
  );
const customGateway = {
  id: "a1",
  name: "My GW",
  url: "https://gw.example.com/v1/",
  format: "openai" as const,
  key: "k1" as string | null,
  models: [{ id: "gpt-x" }],
  piAgentDir: "/state/pi-gateway/gw-a1-pi",
};

describe("gatewaySetup", () => {
  it("points a Codex session at the Gateway with one -c per setting", () => {
    expect(tokenizeCliArgs(codexGatewayLaunchArgs())).toEqual([
      "-c",
      'model_provider="libraos"',
      "-c",
      'model_providers.libraos.name="LibraOS Gateway"',
      "-c",
      'model_providers.libraos.base_url="https://api.libraos.com/v1"',
      "-c",
      'model_providers.libraos.env_key="LIBRAOS_API_KEY"',
      "-c",
      'model_providers.libraos.wire_api="responses"',
    ]);
  });

  it("lists every key model on both agents, the agent's own family first, and keeps the key out of plain values", () => {
    const [claude, codex, opencode] = gatewayProviderInstances(
      "lk_test_key_123456",
      [
        { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "openai/gpt-5.5" },
        { id: "google/gemini-3" },
        { id: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "Qwen/Qwen3.5-Plus" },
      ],
      "/pi",
    );
    // The own family drops its prefix to keep its catalog entry, and its full id is a row too
    // (options from that entry); the rest keep the Gateway's id.
    expect(claude?.instance.config).toEqual({
      customModels: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { slug: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", subProvider: "anthropic" },
        otherFamily("openai/gpt-5.5"),
        otherFamily("google/gemini-3"),
        otherFamily("gemini/gemini-2.5-pro", "Gemini 2.5 Pro"),
        otherFamily("Qwen/Qwen3.5-Plus"),
      ],
      onlyCustomModels: true,
    });
    expect(codex?.instance.config).toMatchObject({
      customModels: [
        { slug: "gpt-5.5" },
        { slug: "openai/gpt-5.5", subProvider: "openai" },
        otherFamily("anthropic/claude-opus-5-5", "Claude Opus 5.5"),
        otherFamily("google/gemini-3"),
        otherFamily("gemini/gemini-2.5-pro", "Gemini 2.5 Pro"),
        otherFamily("Qwen/Qwen3.5-Plus"),
      ],
      onlyCustomModels: true,
    });
    const opencodeConfig = JSON.parse(
      String(
        opencode?.instance.environment?.find((v) => v.name === "OPENCODE_CONFIG_CONTENT")?.value,
      ),
    );
    expect(opencodeConfig.model).toBe("libraos/anthropic/claude-opus-5-5");
    expect(Object.keys(opencodeConfig.provider.libraos.models)).toEqual([
      "anthropic/claude-opus-5-5",
      "openai/gpt-5.5",
      "google/gemini-3",
      "gemini/gemini-2.5-pro",
      "Qwen/Qwen3.5-Plus",
    ]);
    for (const instance of [claude, codex, opencode]) {
      for (const variable of instance?.instance.environment ?? []) {
        if (variable.value === "lk_test_key_123456") expect(variable.sensitive).toBe(true);
        else expect(String(variable.value)).not.toContain("lk_test_key_123456");
      }
    }
  });

  it("keeps both rows of a model when the key adds or drops its bare id", () => {
    const key = "lk_test_key_123456";
    const fullOnly = [
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "anthropic/claude-opus-5-5" },
    ];
    const both = [
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "gpt-5.5", name: "Standalone GPT route" },
      { id: "anthropic/claude-opus-5-5" },
      { id: "claude-opus-5-5" },
    ];
    const initial = Object.fromEntries(
      gatewayProviderInstances(key, both, "/pi").map(({ instanceId, instance }) => [
        instanceId,
        instance,
      ]),
    );
    const entries = (config: unknown) =>
      readCustomModelEntries((config as { customModels?: unknown } | undefined)?.customModels).map(
        ({ slug, subProvider }) => [slug, subProvider],
      );
    // A thread, favorite or hidden model saved as `gpt-5.5` or `openai/gpt-5.5` names the same row
    // whether or not the key also lists the bare id.
    for (const models of [fullOnly, both, fullOnly]) {
      const after = withGatewayModels(initial, models);
      expect(entries(after[GATEWAY_INSTANCE_IDS.codex]?.config)).toEqual([
        ["gpt-5.5", undefined],
        ["openai/gpt-5.5", "openai"],
        ["anthropic/claude-opus-5-5", "anthropic"],
        ...(models === both ? [["claude-opus-5-5", undefined]] : []),
      ]);
      expect(entries(after[GATEWAY_INSTANCE_IDS.claude]?.config)).toEqual([
        ["claude-opus-5-5", undefined],
        ["anthropic/claude-opus-5-5", "anthropic"],
        ["openai/gpt-5.5", "openai"],
        ...(models === both ? [["gpt-5.5", undefined]] : []),
      ]);
    }
  });

  it("changes only the model lists of the Gateway agents still present", () => {
    const key = "lk_test_key_123456";
    const before = [
      { id: "anthropic/claude-opus-5-5" },
      { id: "openai/gpt-5.5" },
      { id: "gemini/gemini-2.5-pro" },
    ];
    const current = Object.fromEntries(
      gatewayProviderInstances(key, before, "/pi")
        .filter(({ instanceId }) => instanceId !== "libraosOpencode")
        .map(({ instanceId, instance }) => [instanceId, instance]),
    );
    expect(withGatewayModels(current, before)).toBe(current);

    // The user's own launch option and proxy on the Codex agent.
    const codex = current[GATEWAY_INSTANCE_IDS.codex]!;
    const userArgs = `${codexGatewayLaunchArgs()} -c 'model_reasoning_summary="none"'`;
    const proxy = { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false };
    const edited = {
      ...current,
      [GATEWAY_INSTANCE_IDS.codex]: {
        ...codex,
        environment: [...(codex.environment ?? []), proxy],
        config: { ...(codex.config as object), launchArgs: userArgs },
      },
    };
    // The key dropped Claude Opus and Gemini: both agents lose them.
    const next = withGatewayModels(edited, [{ id: "openai/gpt-6-luna" }]);
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.config).toEqual({
      setupMode: "existing",
      launchArgs: userArgs,
      customModels: [{ slug: "gpt-6-luna" }, { slug: "openai/gpt-6-luna", subProvider: "openai" }],
      onlyCustomModels: true,
    });
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.environment).toEqual(
      edited[GATEWAY_INSTANCE_IDS.codex]?.environment,
    );
    expect(next[GATEWAY_INSTANCE_IDS.claude]?.config).toEqual({
      customModels: [otherFamily("openai/gpt-6-luna")],
      onlyCustomModels: true,
    });
    expect(next[GATEWAY_INSTANCE_IDS.claude]?.environment).toBe(
      current[GATEWAY_INSTANCE_IDS.claude]?.environment,
    );
    expect(next).not.toHaveProperty(GATEWAY_INSTANCE_IDS.opencode);

    // A Claude agent connected by an older build learns to send the picked id as it is.
    const claude = current[GATEWAY_INSTANCE_IDS.claude]!;
    const older = {
      ...current,
      [GATEWAY_INSTANCE_IDS.claude]: {
        ...claude,
        environment: (claude.environment ?? []).filter(
          ({ name }) => !name.startsWith("CLAUDE_CODE_"),
        ),
      },
    };
    expect(withGatewayModels(older, before)[GATEWAY_INSTANCE_IDS.claude]?.environment).toEqual(
      claude.environment,
    );
  });

  it("offers Claude Code only the ids it sends as they are", () => {
    const [claude, codex] = gatewayProviderInstances(
      "lk_test_key_123456",
      [
        { id: "anthropic/opusplan" },
        { id: "anthropic/opus" },
        { id: "anthropic/claude-opus-4-1" },
        { id: "best" },
        { id: "default" },
        { id: "Sonnet" },
        { id: "haiku" },
        { id: "gemini/gemini-2.5-pro[1m]" },
      ],
      "/pi",
    );
    // No legacy remap (`claude-opus-4-1` to the current Opus), no fallback to another model.
    expect(
      claude?.instance.environment?.filter(({ name }) => name.startsWith("CLAUDE_CODE_")),
    ).toEqual([
      { name: "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP", value: "1", sensitive: false },
      { name: "CLAUDE_CODE_NO_MODEL_FALLBACK", value: "1", sensitive: false },
    ]);
    const slugs = (config: unknown) =>
      readCustomModelEntries((config as { customModels?: unknown } | undefined)?.customModels).map(
        ({ slug }) => slug,
      );
    // Claude Code swaps aliases for its own models; only the lowercase family names are pinned.
    expect(slugs(claude?.instance.config)).toEqual([
      "opus",
      "claude-opus-4-1",
      "anthropic/opus",
      "anthropic/claude-opus-4-1",
      "anthropic/opusplan",
      "haiku",
    ]);
    expect(slugs(codex?.instance.config)).toEqual([
      "anthropic/opusplan",
      "anthropic/opus",
      "anthropic/claude-opus-4-1",
      "best",
      "default",
      "Sonnet",
      "haiku",
      "gemini/gemini-2.5-pro[1m]",
    ]);
  });

  it("gives opencode the new list without touching its other variables", () => {
    const key = "lk_test_key_123456";
    const opencode = gatewayProviderInstances(key, [{ id: "openai/gpt-5.5" }], "/pi").find(
      ({ instanceId }) => instanceId === "libraosOpencode",
    )!.instance;
    const proxy = { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false };
    // What the user set in the inline config: a preference, a model option and their default.
    const userConfig = JSON.parse(String(opencode.environment![1]?.value));
    userConfig.autoupdate = false;
    userConfig.model = "libraos/openai/gpt-6-luna";
    userConfig.provider.libraos.models = { "openai/gpt-6-luna": { limit: { context: 1000 } } };
    const next = withGatewayModels(
      {
        [GATEWAY_INSTANCE_IDS.opencode]: {
          ...opencode,
          environment: [
            opencode.environment![0]!,
            { ...opencode.environment![1]!, value: JSON.stringify(userConfig) },
            proxy,
          ],
          // Added while an older build still offered the control; the key does not serve it.
          config: { enabled: true, customModels: [{ slug: "libraos/openai/gpt-unserved" }] },
        },
      },
      [{ id: "openai/gpt-6-luna" }, { id: "openai/gpt-6-astra" }],
    );
    expect(next[GATEWAY_INSTANCE_IDS.opencode]?.config).toEqual({
      enabled: true,
      customModels: [],
    });
    const environment = next[GATEWAY_INSTANCE_IDS.opencode]?.environment ?? [];
    expect(environment.map((variable) => variable.name)).toEqual([
      "LIBRAOS_API_KEY",
      "OPENCODE_CONFIG_CONTENT",
      "HTTPS_PROXY",
    ]);
    const config = JSON.parse(String(environment[1]?.value));
    expect(config.provider.libraos.models).toEqual({
      "openai/gpt-6-luna": { limit: { context: 1000 } },
      "openai/gpt-6-astra": {},
    });
    expect(config.autoupdate).toBe(false);
    expect(config.model).toBe("libraos/openai/gpt-6-luna");
    expect(config.provider.libraos.options.baseURL).toBe("https://api.libraos.com/v1");
  });

  it("limits agents connected before #117 to the models they already list", () => {
    const { onlyCustomModels: _flag, ...config } = gatewayProviderInstances(
      "lk_test_key_123456",
      [{ id: "openai/gpt-5.5" }],
      "/pi",
    ).find(({ instanceId }) => instanceId === "libraosCodex")!.instance.config as Record<
      string,
      unknown
    >;
    const codex = { driver: "codex", enabled: true, config } as never;
    const next = withGatewayModels({ [GATEWAY_INSTANCE_IDS.codex]: codex }, null);
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.config).toEqual({
      ...config,
      onlyCustomModels: true,
    });
  });

  it("shows the Gateway's own message for a refused key", () => {
    expect(
      gatewayRefusal(401, {
        error: { message: "This API key is not valid.", type: "invalid_api_key" },
      }),
    ).toBe("This API key is not valid.");
    expect(gatewayRefusal(502, "<html>")).toBe("LibraOS Gateway answered HTTP 502.");
    const echoed = (message: string) => gatewayRefusal(401, { error: { message } });
    expect(echoed("Key lk_live_0123456789abcdef was revoked.\nat auth.ts:12")).toBe(
      "Key [redacted] was revoked.",
    );
    expect(echoed("Bad header: Bearer lk_x.y")).toBe("Bad header: [redacted]");
    expect(echoed("x".repeat(500))).toHaveLength(200);
  });

  it("openai format builds codex and opencode with one /v1", () => {
    const entries = customGatewayInstances(customGateway);
    expect(entries.map(({ instanceId }) => instanceId)).toEqual([
      "gw-a1-codex",
      "gw-a1-opencode",
      "gw-a1-pi",
    ]);
    const [codex] = entries;
    expect(codex?.instance.displayName).toBe("Codex · My GW");
    expect(codex?.instance.environment).toEqual([
      { name: "CUSTOM_GATEWAY_API_KEY", value: "k1", sensitive: true },
    ]);
    const config = codex?.instance.config as { launchArgs: string };
    expect(tokenizeCliArgs(config.launchArgs)).toEqual([
      "-c",
      'model_provider="gw_a1"',
      "-c",
      'model_providers.gw_a1.name="My GW"',
      "-c",
      'model_providers.gw_a1.base_url="https://gw.example.com/v1"',
      "-c",
      'model_providers.gw_a1.env_key="CUSTOM_GATEWAY_API_KEY"',
      "-c",
      'model_providers.gw_a1.wire_api="responses"',
    ]);
    expect(codex?.instance.config).toMatchObject({
      customModels: [{ slug: "gpt-x" }],
      onlyCustomModels: true,
    });
    const opencode = opencodeConfigOf(entries).provider.gw_a1;
    expect(opencode.npm).toBe("@ai-sdk/openai-compatible");
    expect(opencode.options).toEqual({
      baseURL: "https://gw.example.com/v1",
      apiKey: "{env:CUSTOM_GATEWAY_API_KEY}",
    });
  });

  it("anthropic format builds claude and opencode without /v1 for claude", () => {
    for (const url of [
      "https://gw.example.com",
      "https://gw.example.com/",
      "https://gw.example.com/v1",
    ]) {
      const entries = customGatewayInstances({ ...customGateway, url, format: "anthropic" });
      expect(entries.map(({ instanceId }) => instanceId)).toEqual([
        "gw-a1-claude",
        "gw-a1-opencode",
      ]);
      expect(env(entries[0], "ANTHROPIC_BASE_URL")).toBe("https://gw.example.com");
      // One agent per format, so a custom gateway keeps its ids as given and Claude Code's defaults.
      expect(entries[0]?.instance.environment?.map(({ name }) => name)).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY",
      ]);
      expect(entries[0]?.instance.config).toEqual({
        customModels: [{ slug: "gpt-x" }],
        onlyCustomModels: true,
      });
      const opencode = opencodeConfigOf(entries).provider.gw_a1;
      expect(opencode.npm).toBe("@ai-sdk/anthropic");
      expect(opencode.options.baseURL).toBe("https://gw.example.com/v1");
    }
  });

  it("both formats share a key and model list while using each agent's endpoint", () => {
    for (const url of ["https://gw.example.com", "https://gw.example.com/v1/"]) {
      const entries = customGatewayInstances({ ...customGateway, url, format: "both" });
      expect(entries.map(({ instanceId }) => instanceId)).toEqual([
        "gw-a1-claude",
        "gw-a1-codex",
        "gw-a1-opencode",
        "gw-a1-pi",
      ]);
      const [claude, codex] = entries;
      expect(claude?.instance.displayName).toBe("Claude Code · My GW");
      expect(env(claude, "ANTHROPIC_BASE_URL")).toBe("https://gw.example.com");
      expect(env(claude, "ANTHROPIC_API_KEY")).toBe("k1");
      expect(env(codex, "CUSTOM_GATEWAY_API_KEY")).toBe("k1");
      const config = codex?.instance.config as { launchArgs: string };
      expect(tokenizeCliArgs(config.launchArgs)).toContain(
        'model_providers.gw_a1.base_url="https://gw.example.com/v1"',
      );
      expect(tokenizeCliArgs(config.launchArgs)).toContain(
        'model_providers.gw_a1.env_key="CUSTOM_GATEWAY_API_KEY"',
      );
      for (const entry of [claude, codex]) {
        expect(entry?.instance.config).toMatchObject({
          customModels: [{ slug: "gpt-x" }],
          onlyCustomModels: true,
        });
      }
      expect(opencodeConfigOf(entries).provider.gw_a1.npm).toBe("@ai-sdk/openai-compatible");
    }
  });

  it("no key writes no key", () => {
    for (const format of ["openai", "anthropic"] as const) {
      const entries = customGatewayInstances({ ...customGateway, format, key: null });
      for (const { instance } of entries) {
        expect(instance.environment?.filter((variable) => variable.sensitive)).toEqual([]);
        expect(JSON.stringify(instance.config)).not.toContain("env_key");
      }
      expect(opencodeConfigOf(entries).provider.gw_a1.options).not.toHaveProperty("apiKey");
    }
  });

  it("a renamed custom gateway renames its agents and keeps its key and models", () => {
    const current = Object.fromEntries(
      customGatewayInstances(customGateway).map(({ instanceId, instance }) => [
        instanceId,
        instance,
      ]),
    );
    const renamed = { ...customGateway, name: "Work" };
    const next = withCustomGateway(current, renamed, null);
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.displayName).toBe("Codex · Work");
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.environment).toEqual(
      current[ProviderInstanceId.make("gw-a1-codex")]?.environment,
    );
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.config).toEqual(
      customGatewayInstances({ ...renamed, key: "k1" })[0]?.instance.config,
    );
    expect(next[ProviderInstanceId.make("gw-a1-opencode")]?.displayName).toBe("opencode · Work");
    const opencode = JSON.parse(
      String(next[ProviderInstanceId.make("gw-a1-opencode")]?.environment?.[1]?.value),
    );
    expect(opencode.provider.gw_a1.name).toBe("Work");
    expect(Object.keys(opencode.provider.gw_a1.models)).toEqual(["gpt-x"]);
    expect(next[ProviderInstanceId.make("gw-a1-pi")]?.displayName).toBe("Pi · Work");
    expect(next[ProviderInstanceId.make("gw-a1-pi")]?.environment).toEqual(
      current[ProviderInstanceId.make("gw-a1-pi")]?.environment,
    );
    expect(withCustomGateway(next, renamed, null)).toBe(next);
  });

  it("a gateway with only its Pi agent keeps its list there, and a new list reaches it", () => {
    const current = Object.fromEntries(
      customGatewayInstances(customGateway)
        .filter(({ instanceId }) => instanceId === "gw-a1-pi")
        .map(({ instanceId, instance }) => [instanceId, instance]),
    );
    expect(customGatewayModels(current, "a1")).toEqual([{ id: "gpt-x" }]);
    const next = withCustomGateway(current, customGateway, [{ id: "gpt-y", name: "Y" }]);
    expect(next[ProviderInstanceId.make("gw-a1-pi")]?.config).toEqual({
      customModels: [{ slug: "gw_a1/gpt-y", name: "Y" }],
    });
    expect(customGatewayModels(next, "a1")).toEqual([{ id: "gpt-y", name: "Y" }]);
  });

  it("an Anthropic-format gateway gets no Pi agent", () => {
    const entries = customGatewayInstances({ ...customGateway, format: "anthropic" });
    expect(entries.map(({ instanceId }) => instanceId)).not.toContain("gw-a1-pi");
  });
});

describe("piGatewayFiles", () => {
  const models = [{ id: "openai/gpt-5.5" }, { id: "anthropic/claude-opus-5-5", name: "Opus" }];

  it("makes the gateway Pi's only provider, the key named by its variable", () => {
    const files = piGatewayFiles(LIBRAOS_PI_TARGET, models, undefined);
    expect(JSON.parse(files.models)).toEqual({
      providers: {
        libraos: {
          baseUrl: "https://api.libraos.com/v1",
          api: "openai-completions",
          apiKey: "$LIBRAOS_API_KEY",
          models: [{ id: "openai/gpt-5.5" }, { id: "anthropic/claude-opus-5-5", name: "Opus" }],
        },
      },
    });
    expect(JSON.parse(files.settings)).toEqual({
      defaultProvider: "libraos",
      defaultModel: "anthropic/claude-opus-5-5",
    });
  });

  it("a keyless custom gateway gets a placeholder key and its own /v1 base", () => {
    const target = customPiTarget({ id: "a1", url: "http://localhost:4000/v1/" }, false);
    const provider = JSON.parse(piGatewayFiles(target, models, undefined).models).providers.gw_a1;
    expect(provider.baseUrl).toBe("http://localhost:4000/v1");
    expect(provider.apiKey).toBe("none");
  });

  it("keeps what Pi saved and its model while the gateway still serves it", () => {
    const saved = JSON.stringify({
      defaultProvider: "libraos",
      defaultModel: "openai/gpt-5.5",
      theme: "dark",
    });
    expect(JSON.parse(piGatewayFiles(LIBRAOS_PI_TARGET, models, saved).settings)).toEqual({
      defaultProvider: "libraos",
      defaultModel: "openai/gpt-5.5",
      theme: "dark",
    });
    const gone = piGatewayFiles(LIBRAOS_PI_TARGET, [{ id: "openai/gpt-6" }], saved);
    expect(JSON.parse(gone.settings)).toEqual({
      defaultProvider: "libraos",
      defaultModel: "openai/gpt-6",
      theme: "dark",
    });
    expect(JSON.parse(piGatewayFiles(LIBRAOS_PI_TARGET, models, "{not json").settings)).toEqual({
      defaultProvider: "libraos",
      defaultModel: "anthropic/claude-opus-5-5",
    });
  });
});
