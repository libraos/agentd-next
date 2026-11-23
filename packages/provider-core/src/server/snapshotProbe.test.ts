import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  isCommandMissingCause,
  resolveProviderProbeTimeoutMs,
  parseGenericCliVersion,
  buildServerProvider,
  NO_SERVED_MODELS_MESSAGE,
  providerModelsFromSettings,
  spawnAndCollect,
  withNoServedModelsNotice,
} from "./snapshotProbe.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("renames a built-in model when a named entry uses its slug", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          shortName: "5.5",
          isCustom: false,
          capabilities,
        },
      ],
      [{ slug: "gpt-5.5", name: "Team GPT" }],
      capabilities,
    );

    expect(models).toEqual([{ slug: "gpt-5.5", name: "Team GPT", isCustom: false, capabilities }]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });

  it("lists only the served models when the endpoint's list replaces the catalog", () => {
    const fast = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const plain = createModelCapabilities({ optionDescriptors: [] });
    const catalog = [
      { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", isCustom: false, capabilities: fast },
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: fast },
      { slug: "gpt-6-astra", name: "GPT-6-Astra", isCustom: false, capabilities: fast },
      { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: plain },
    ];

    const models = providerModelsFromSettings(
      catalog,
      [
        { slug: "gpt-6-astra", name: "OpenAI: GPT-6 Astra" },
        "gpt-6.1-sol",
        { slug: "gpt-7-preview", name: "GPT-7 Preview" },
        { slug: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro", subProvider: "gemini" },
        "team-a/deployment",
        { slug: "openai/gpt-6.2-sol", subProvider: "openai" },
      ],
      plain,
      { onlyCustomModels: true },
    );

    expect(models).toEqual([
      catalog[1],
      catalog[2],
      { slug: "gpt-7-preview", name: "GPT-7 Preview", isCustom: true, capabilities: plain },
      // A model is labelled with the family its entry names, never guessed from its id.
      {
        slug: "gemini/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        subProvider: "gemini",
        isCustom: true,
        capabilities: plain,
      },
      { slug: "team-a/deployment", name: "team-a/deployment", isCustom: true, capabilities: plain },
      // A family-prefixed catalog id offers that catalog model's options.
      {
        slug: "openai/gpt-6.2-sol",
        name: "openai/gpt-6.2-sol",
        subProvider: "openai",
        isCustom: true,
        capabilities: fast,
      },
    ]);
  });

  it("lists nothing when the endpoint serves none of the agent's models", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const catalog = [{ slug: "claude-opus-4-8", name: "Opus", isCustom: false, capabilities }];

    expect(
      providerModelsFromSettings(catalog, [], capabilities, { onlyCustomModels: true }),
    ).toEqual([]);
    expect(providerModelsFromSettings(catalog, [], capabilities)).toEqual(catalog);
  });
});

describe("withNoServedModelsNotice", () => {
  const draft = (models: ReturnType<typeof providerModelsFromSettings>) =>
    buildServerProvider({
      presentation: { displayName: "Claude" },
      enabled: true,
      checkedAt: "2026-11-19T00:00:00.000Z",
      models,
      probe: {
        installed: true,
        version: "2.1.0",
        status: "ready",
        auth: { status: "authenticated" },
      },
    });

  it("says why an agent limited to its key's models has none", () => {
    const notice = withNoServedModelsNotice(draft([]), true);
    expect(notice.status).toBe("warning");
    expect(notice.message).toBe(NO_SERVED_MODELS_MESSAGE);
  });

  it("leaves an agent on its own catalog alone", () => {
    expect(withNoServedModelsNotice(draft([]), undefined).status).toBe("ready");
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
  });
});

describe("ProviderCommandNotFoundError", () => {
  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

describe("resolveProviderProbeTimeoutMs", () => {
  it.each([
    "codex",
    "claude",
    "cursor",
    "antigravity",
    "grok",
    "kiro",
    "fx",
    "pi",
    "muse",
    "opencode",
    "acp_registry",
  ])("uses only %s's readiness override", (provider) => {
    const key = `T3CODE_${provider.toUpperCase()}_PROBE_TIMEOUT_MS`;
    expect(resolveProviderProbeTimeoutMs(provider, 25000, { [key]: "60000" })).toBe(60000);
    expect(resolveProviderProbeTimeoutMs(provider, 25000, { [key]: "1000" })).toBe(25000);
    expect(
      resolveProviderProbeTimeoutMs(provider, 25000, { T3CODE_OTHER_PROBE_TIMEOUT_MS: "60000" }),
    ).toBe(25000);
  });
  it.each([undefined, "", " ", "bad", "0", "-1", "1.5", "Infinity", "2147483648"])(
    "retains the phase default for invalid value %s",
    (value) => {
      expect(
        resolveProviderProbeTimeoutMs("claude", 25000, { T3CODE_CLAUDE_PROBE_TIMEOUT_MS: value }),
      ).toBe(25000);
    },
  );
});

describe("spawnAndCollect", () => {
  it.effect.each(["stdout", "stderr"] as const)(
    "rejects oversized %s after draining the process streams",
    (stream) =>
      Effect.gen(function* () {
        let drainedChunks = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(120);
        const output = Stream.fromIterable(Array.from({ length: 9 }, () => chunk)).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              drainedChunks += 1;
            }),
          ),
        );
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: stream === "stdout" ? output : Stream.empty,
              stderr: stream === "stderr" ? output : Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const result = yield* spawnAndCollect(
          "fixture-cli",
          ChildProcess.make("fixture-cli", ["--version"]),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            _tag: "ProviderProbeOutputLimitError",
            stream,
            maxBytes: 8 * 1024 * 1024,
          });
        }
        expect(drainedChunks).toBe(9);
      }),
  );

  // regression: #35262 - without forceKillAfter a timed-out probe whose CLI ignores
  // SIGTERM waits for it to exit, so the caller's timeout never returns.
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "lets a timed-out probe return when the CLI ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const result = yield* spawnAndCollect(
          "sh",
          ChildProcess.make("sh", ["-c", 'trap "" TERM; sleep 30']),
        ).pipe(Effect.timeoutOption("200 millis"));
        expect(Option.isNone(result)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
