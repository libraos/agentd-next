import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { AgentdBridge } from "../agentd/AgentdBridge.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  codexGatewayLaunchArgs,
  GATEWAY_INSTANCE_IDS,
  gatewayProviderInstances,
} from "./gatewaySetup.ts";
import * as LibraosGateway from "./LibraosGateway.ts";

// Another family's model keeps its Gateway id, sits under its family and has no agent options.
const otherFamily = (slug: string, name?: string) => ({
  slug,
  ...(name ? { name } : {}),
  subProvider: slug.split("/")[0],
  capabilities: { optionDescriptors: [] },
});
// The agent's own family by its full id: options come from the catalog model it names.
const ownFullId = (slug: string) => ({ slug, subProvider: slug.split("/")[0] });

const GOOD_KEY = "lk_good_key_0123456789";
// A key the user put on the opencode Gateway agent instead of the connected one.
const OWN_KEY = "lk_own_key_0123456789";
const GATEWAY_INSTANCES = ["libraosClaude", "libraosCodex", "libraosOpencode", "libraosPi"];

const SIGNED_IN_KEY = "lk_signed_in_key_0123456789";
const SESSION_TOKEN = "session-token-not-to-keep";

interface CloudRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** What Cloud answers each /v1/device/token poll, in turn; the last one repeats. */
type TokenScript = Array<{ readonly status: number; readonly body: unknown }>;

const pending = { status: 400, body: { error: "authorization_pending" } };
const granted = {
  status: 200,
  body: {
    access_token: SESSION_TOKEN,
    token_type: "Bearer",
    email: "jo@example.com",
    workspace: "Acme",
  },
};

function setup(
  options: {
    readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
    /** Agent commands on this host's PATH. */
    readonly found?: ReadonlyArray<string>;
    /** Settings never ready, so the startup refresh and backfill wait for the test to run them. */
    readonly holdStartup?: boolean;
    readonly tokenScript?: TokenScript;
    readonly createdKey?: string;
  } = {},
) {
  // What Console says of the key now: served, revoked, or the Gateway is down.
  const gatewayState = { now: "served" as "served" | "revoked" | "down" };
  const served: Array<{ readonly id: string }> = [
    { id: "anthropic/claude-opus-5-5" },
    { id: "openai/gpt-5.5" },
  ];
  const tokenScript = options.tokenScript ?? [granted];
  const cloud: CloudRequest[] = [];
  const secrets = new Map<string, Uint8Array>();
  const runs: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        runs.push({ command: input.command, args: input.args });
        const help = input.args.includes("--help");
        return {
          stdout: help ? "usage: agentd init [--no-services] [--model-key FILE]" : "set up",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } as ProcessRunner.ProcessRunOutput;
      }),
  });
  const cloudAnswer = (url: URL, method: string) => {
    if (url.pathname === "/v1/device/code") {
      return Response.json({
        device_code: "dev-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://console.libraos.com/device",
        verification_uri_complete: "https://console.libraos.com/device?user_code=ABCD-EFGH",
        expires_in: 60,
        interval: 5,
      });
    }
    if (url.pathname === "/v1/device/token") {
      const next = tokenScript.length > 1 ? tokenScript.shift()! : tokenScript[0]!;
      return Response.json(next.body, { status: next.status });
    }
    if (url.pathname === "/v1/gateway-keys" && method === "POST") {
      return Response.json(
        { id: "key_1", key: options.createdKey ?? SIGNED_IN_KEY, hint: "lk_…6789" },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/gateway-keys/key_1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.origin === "https://console.libraos.com") {
        const body = request.body;
        cloud.push({
          method: request.method,
          url: url.pathname,
          authorization: request.headers.authorization,
          body:
            "body" in body && body.body instanceof Uint8Array
              ? new TextDecoder().decode(body.body)
              : "",
        });
        return HttpClientResponse.fromWeb(request, cloudAnswer(url, request.method));
      }
      const key = request.headers.authorization?.replace("Bearer ", "");
      return HttpClientResponse.fromWeb(
        request,
        gatewayState.now === "down"
          ? Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 })
          : (key === GOOD_KEY || key === SIGNED_IN_KEY) && gatewayState.now === "served"
            ? Response.json({ data: served })
            : key === OWN_KEY
              ? Response.json({ data: [{ id: "openai/gpt-6-sol" }] })
              : Response.json(
                  { error: { message: "This API key is not valid.", type: "invalid_api_key" } },
                  { status: 401 },
                ),
      );
    }),
  );
  const layer = Layer.effect(LibraosGateway.LibraosGateway, LibraosGateway.make()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        // The key file's mode 600 is the POSIX path; Windows uses an ACL instead.
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Hostname, "testhost"),
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(ProcessRunner.ProcessRunner, runner),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.mock(AgentdBridge)({ binary: Effect.succeed("agentd") }),
        Layer.succeed(CommandAvailability, (command: string) =>
          Effect.succeed(options.found?.includes(command) ?? false),
        ),
        options.holdStartup
          ? Layer.effect(
              ServerSettingsService,
              Effect.map(Effect.service(ServerSettingsService), (service) =>
                ServerSettingsService.of({ ...service, ready: Effect.never }),
              ),
            ).pipe(Layer.provide(ServerSettingsService.layerTest(options.settings)))
          : ServerSettingsService.layerTest(options.settings),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { gatewayState, served, secrets, runs, cloud, layer };
}

it.effect("a refused key shows the Gateway's message and keeps nothing", () => {
  const { secrets, runs, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const exit = yield* Effect.exit(gateway.connect("lk_revoked_key_0123456789"));
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(String(exit.cause), "This API key is not valid.");
    }
    assert.strictEqual(secrets.size, 0);
    assert.strictEqual(runs.length, 0);
    const settings = yield* ServerSettingsService;
    const instances = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(instances, id);
  }).pipe(Effect.provide(layer));
});

it.effect("connect keeps the key for agentd and the agents; disconnect removes it all", () => {
  const { secrets, runs, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const keyFile = path.join(
      (yield* ServerConfig.ServerConfig).stateDir,
      "agentd",
      "libraos-gateway-key",
    );

    const connected = yield* gateway.connect(`  ${GOOD_KEY}\n`);
    assert.isTrue(connected.connected);
    assert.deepStrictEqual(
      connected.models.map((model) => model.id),
      ["anthropic/claude-opus-5-5", "openai/gpt-5.5"],
    );
    assert.deepStrictEqual(connected.agentd, { ok: true, output: "set up" });
    assert.strictEqual(new TextDecoder().decode(secrets.get("libraos-gateway-key")), GOOD_KEY);
    assert.strictEqual(yield* fs.readFileString(keyFile), `${GOOD_KEY}\n`);
    assert.strictEqual((yield* fs.stat(keyFile)).mode & 0o777, 0o600);
    assert.deepStrictEqual(runs.at(-1)?.args, ["init", "--model-key", keyFile, "--no-services"]);
    const instances = (yield* settings.getSettings).providerInstances;
    for (const id of GATEWAY_INSTANCES) assert.property(instances, id);

    // Pi reaches the Gateway alone, from a directory of the server's; the key stays in the env.
    const piDir = path.join((yield* ServerConfig.ServerConfig).stateDir, "pi-gateway", "libraosPi");
    const pi = instances[GATEWAY_INSTANCE_IDS.pi];
    assert.strictEqual(pi?.driver, "pi");
    assert.strictEqual(pi?.displayName, "Pi · LibraOS Gateway");
    assert.deepStrictEqual(pi?.environment, [
      { name: "LIBRAOS_API_KEY", value: GOOD_KEY, sensitive: true },
      { name: "PI_CODING_AGENT_DIR", value: piDir, sensitive: false },
    ]);
    assert.deepStrictEqual(pi?.config, {
      customModels: [
        { slug: "libraos/anthropic/claude-opus-5-5" },
        { slug: "libraos/openai/gpt-5.5" },
      ],
    });
    const modelsJson = yield* fs.readFileString(path.join(piDir, "models.json"));
    assert.notInclude(modelsJson, GOOD_KEY);
    assert.deepStrictEqual(JSON.parse(modelsJson), {
      providers: {
        libraos: {
          baseUrl: "https://api.libraos.com/v1",
          api: "openai-completions",
          apiKey: "$LIBRAOS_API_KEY",
          models: [{ id: "anthropic/claude-opus-5-5" }, { id: "openai/gpt-5.5" }],
        },
      },
    });
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(path.join(piDir, "settings.json"))),
      { defaultProvider: "libraos", defaultModel: "anthropic/claude-opus-5-5" },
    );
    // No other agent on this host: Pi is the first-run default.
    assert.deepStrictEqual((yield* settings.getSettings).defaultModelSelection, {
      instanceId: GATEWAY_INSTANCE_IDS.pi,
      model: "default",
    });

    const disconnected = yield* gateway.disconnect;
    assert.deepStrictEqual(disconnected, {
      connected: false,
      models: [],
      agentd: null,
      refusal: null,
      account: null,
      signIn: null,
      notice: null,
    });
    assert.strictEqual(secrets.size, 0);
    assert.isFalse(yield* fs.exists(keyFile));
    const remaining = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(remaining, id);
    assert.isFalse(yield* fs.exists(piDir));
    assert.isNull((yield* settings.getSettings).defaultModelSelection);
  }).pipe(Effect.provide(layer));
});

it.effect("with Claude Code or Codex on the host, connecting leaves the default alone", () =>
  Effect.gen(function* () {
    for (const found of [["claude"], ["codex"]]) {
      const { layer } = setup({ found });
      yield* Effect.gen(function* () {
        yield* (yield* LibraosGateway.LibraosGateway).connect(GOOD_KEY);
        const settings = yield* (yield* ServerSettingsService).getSettings;
        assert.property(settings.providerInstances, GATEWAY_INSTANCE_IDS.pi);
        assert.isNull(settings.defaultModelSelection);
      }).pipe(Effect.provide(layer));
    }
    // A default the user chose stays, and disconnecting does not clear it.
    const chosen = { instanceId: GATEWAY_INSTANCE_IDS.codex, model: "gpt-5.5" };
    const { layer } = setup({ settings: { defaultModelSelection: chosen } });
    yield* Effect.gen(function* () {
      const gateway = yield* LibraosGateway.LibraosGateway;
      const settings = yield* ServerSettingsService;
      yield* gateway.connect(GOOD_KEY);
      assert.deepStrictEqual((yield* settings.getSettings).defaultModelSelection, chosen);
      yield* gateway.disconnect;
      assert.deepStrictEqual((yield* settings.getSettings).defaultModelSelection, chosen);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a refresh gives the Gateway agents the key's models as they are now", () => {
  const { served, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    yield* gateway.connect(GOOD_KEY);
    const claude = (yield* settings.getSettings).providerInstances[GATEWAY_INSTANCE_IDS.claude];
    assert.isDefined(claude);
    if (claude === undefined) return;
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: GATEWAY_INSTANCE_IDS.claude,
      instance: { ...claude, enabled: false },
    });
    // What the user set on the Codex agent: a launch option and a proxy.
    const codex = (yield* settings.getSettings).providerInstances[GATEWAY_INSTANCE_IDS.codex];
    const userLaunchArgs = `${codexGatewayLaunchArgs()} -c 'model_reasoning_summary="none"'`;
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: GATEWAY_INSTANCE_IDS.codex,
      instance: {
        ...codex!,
        environment: [
          ...(codex?.environment ?? []),
          { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false },
        ],
        config: { ...(codex?.config as object), launchArgs: userLaunchArgs },
      },
    });

    // On the opencode agent: its own key and an unrelated preference in its inline config.
    const opencode = (yield* settings.getSettings).providerInstances[GATEWAY_INSTANCE_IDS.opencode];
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: GATEWAY_INSTANCE_IDS.opencode,
      instance: {
        ...opencode!,
        environment: (opencode?.environment ?? []).map((variable) =>
          variable.name === "LIBRAOS_API_KEY"
            ? { ...variable, value: OWN_KEY }
            : variable.name === "OPENCODE_CONFIG_CONTENT"
              ? {
                  ...variable,
                  value: JSON.stringify({
                    ...JSON.parse(String(variable.value)),
                    autoupdate: false,
                  }),
                }
              : variable,
        ),
      },
    });

    // In Console the key loses its Claude model and gains a Codex one; both agents follow.
    served.splice(0, served.length, { id: "openai/gpt-5.5" }, { id: "openai/gpt-6-luna" });
    yield* gateway.refreshModels;

    const instances = (yield* settings.getSettings).providerInstances;
    assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.codex]?.config, {
      setupMode: "existing",
      launchArgs: userLaunchArgs,
      customModels: [
        { slug: "gpt-5.5" },
        { slug: "gpt-6-luna" },
        ownFullId("openai/gpt-5.5"),
        ownFullId("openai/gpt-6-luna"),
      ],
      onlyCustomModels: true,
    });
    assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.claude]?.config, {
      customModels: [otherFamily("openai/gpt-5.5"), otherFamily("openai/gpt-6-luna")],
      onlyCustomModels: true,
    });
    assert.strictEqual(instances[GATEWAY_INSTANCE_IDS.claude]?.enabled, false);
    assert.deepInclude(instances[GATEWAY_INSTANCE_IDS.codex]?.environment ?? [], {
      name: "HTTPS_PROXY",
      value: "http://proxy:3128",
      sensitive: false,
    });
    const opencodeConfig = JSON.parse(
      String(
        instances[GATEWAY_INSTANCE_IDS.opencode]?.environment?.find(
          (variable) => variable.name === "OPENCODE_CONFIG_CONTENT",
        )?.value,
      ),
    );
    assert.strictEqual(opencodeConfig.autoupdate, false);
    // The list of the key opencode sends, not the connected key's.
    assert.deepStrictEqual(Object.keys(opencodeConfig.provider.libraos.models), [
      "openai/gpt-6-sol",
    ]);
    assert.strictEqual(opencodeConfig.model, "libraos/openai/gpt-6-sol");

    // Pi gets the connected key's list, in its config and its models.json; Pi's own pick stays.
    assert.deepStrictEqual(
      (instances[GATEWAY_INSTANCE_IDS.pi]?.config as { customModels?: unknown } | undefined)
        ?.customModels,
      [{ slug: "libraos/openai/gpt-5.5" }, { slug: "libraos/openai/gpt-6-luna" }],
    );
    const piDir = String(
      instances[GATEWAY_INSTANCE_IDS.pi]?.environment?.find(
        (variable) => variable.name === "PI_CODING_AGENT_DIR",
      )?.value,
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modelsJson = JSON.parse(yield* fs.readFileString(path.join(piDir, "models.json")));
    assert.deepStrictEqual(modelsJson.providers.libraos.models, [
      { id: "openai/gpt-5.5" },
      { id: "openai/gpt-6-luna" },
    ]);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(path.join(piDir, "settings.json"))),
      { defaultProvider: "libraos", defaultModel: "openai/gpt-5.5" },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a refresh after the key is revoked leaves the agents no models and says why", () => {
  const { gatewayState, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    yield* gateway.connect(GOOD_KEY);

    // Down is not refused: the last list stays.
    gatewayState.now = "down";
    yield* gateway.refreshModels;
    let instances = (yield* settings.getSettings).providerInstances;
    assert.deepStrictEqual(
      (instances[GATEWAY_INSTANCE_IDS.codex]?.config as { customModels?: unknown } | undefined)
        ?.customModels,
      [{ slug: "gpt-5.5" }, ownFullId("openai/gpt-5.5"), otherFamily("anthropic/claude-opus-5-5")],
    );
    assert.isNull((yield* gateway.status).refusal);

    gatewayState.now = "revoked";
    yield* gateway.refreshModels;
    instances = (yield* settings.getSettings).providerInstances;
    for (const id of [GATEWAY_INSTANCE_IDS.claude, GATEWAY_INSTANCE_IDS.codex]) {
      assert.deepStrictEqual(
        (instances[id]?.config as { customModels?: unknown } | undefined)?.customModels,
        [],
      );
    }
    const status = yield* gateway.status;
    assert.deepStrictEqual(status.models, []);
    assert.strictEqual(status.refusal, "This API key is not valid.");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "agents connected before #117 are limited to the key's models without the Gateway",
  () => {
    const existing = gatewayProviderInstances(GOOD_KEY, [{ id: "openai/gpt-5.5" }], "/pi").map(
      ({ instanceId, instance }) => {
        const { onlyCustomModels: _flag, ...config } = instance.config as Record<string, unknown>;
        return [instanceId, { ...instance, config }] as const;
      },
    );
    const { gatewayState, secrets, layer } = setup({
      settings: { providerInstances: Object.fromEntries(existing) },
    });
    secrets.set("libraos-gateway-key", new TextEncoder().encode(GOOD_KEY));
    gatewayState.now = "down";
    return Effect.gen(function* () {
      const gateway = yield* LibraosGateway.LibraosGateway;
      const settings = yield* ServerSettingsService;
      yield* gateway.refreshModels;
      const instances = (yield* settings.getSettings).providerInstances;
      assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.codex]?.config, {
        setupMode: "existing",
        launchArgs: codexGatewayLaunchArgs(),
        customModels: [{ slug: "gpt-5.5" }, ownFullId("openai/gpt-5.5")],
        onlyCustomModels: true,
      });
      assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.claude]?.config, {
        customModels: [otherFamily("openai/gpt-5.5")],
        onlyCustomModels: true,
      });
    }).pipe(Effect.provide(layer));
  },
);

// A key connected before Pi shipped has Claude Code, Codex and opencode agents but no Pi.
const beforePi = (pi?: { readonly enabled: boolean }) =>
  Object.fromEntries(
    gatewayProviderInstances(GOOD_KEY, [{ id: "openai/gpt-5.5" }], "/pi").flatMap(
      ({ instanceId, instance }) =>
        instanceId !== GATEWAY_INSTANCE_IDS.pi
          ? [[instanceId, instance]]
          : pi === undefined
            ? []
            : [[instanceId, { ...instance, enabled: pi.enabled }]],
    ),
  );

it.effect("a key connected before the Gateway had Pi gets the Pi agent at start, once", () => {
  const { secrets, layer } = setup({
    settings: { providerInstances: beforePi() },
    holdStartup: true,
  });
  secrets.set("libraos-gateway-key", new TextEncoder().encode(GOOD_KEY));
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const piDir = path.join((yield* ServerConfig.ServerConfig).stateDir, "pi-gateway", "libraosPi");
    yield* gateway.refreshModels;
    yield* gateway.backfillPi;
    const instances = (yield* settings.getSettings).providerInstances;
    assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.pi]?.environment, [
      { name: "LIBRAOS_API_KEY", value: GOOD_KEY, sensitive: true },
      { name: "PI_CODING_AGENT_DIR", value: piDir, sensitive: false },
    ]);
    const modelsJson = yield* fs.readFileString(path.join(piDir, "models.json"));
    assert.notInclude(modelsJson, GOOD_KEY);
    assert.deepStrictEqual(
      JSON.parse(modelsJson).providers.libraos.models.map((model: { id: string }) => model.id),
      ["anthropic/claude-opus-5-5", "openai/gpt-5.5"],
    );

    // Removed afterwards, it stays removed through later starts.
    yield* settings.updateProviderInstance({
      operation: "remove",
      instanceId: GATEWAY_INSTANCE_IDS.pi,
    });
    yield* gateway.backfillPi;
    assert.notProperty((yield* settings.getSettings).providerInstances, GATEWAY_INSTANCE_IDS.pi);
  }).pipe(Effect.provide(layer));
});

it.effect("a Pi agent the user removed or turned off is not given back at start", () =>
  Effect.gen(function* () {
    // Turned off: the instance stays as it is.
    {
      const { secrets, layer } = setup({
        settings: { providerInstances: beforePi({ enabled: false }) },
        holdStartup: true,
      });
      secrets.set("libraos-gateway-key", new TextEncoder().encode(GOOD_KEY));
      yield* Effect.gen(function* () {
        const gateway = yield* LibraosGateway.LibraosGateway;
        const settings = yield* ServerSettingsService;
        yield* gateway.refreshModels;
        yield* gateway.backfillPi;
        const pi = (yield* settings.getSettings).providerInstances[GATEWAY_INSTANCE_IDS.pi];
        assert.isFalse(pi?.enabled);
      }).pipe(Effect.provide(layer));
    }
    // Removed under a build that had Pi: its directory is left, and no agent comes back.
    {
      const { secrets, layer } = setup({
        settings: { providerInstances: beforePi() },
        holdStartup: true,
      });
      secrets.set("libraos-gateway-key", new TextEncoder().encode(GOOD_KEY));
      yield* Effect.gen(function* () {
        const gateway = yield* LibraosGateway.LibraosGateway;
        const settings = yield* ServerSettingsService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
        yield* fs.makeDirectory(path.join(stateDir, "pi-gateway", "libraosPi"), {
          recursive: true,
        });
        yield* gateway.refreshModels;
        yield* gateway.backfillPi;
        assert.notProperty(
          (yield* settings.getSettings).providerInstances,
          GATEWAY_INSTANCE_IDS.pi,
        );
      }).pipe(Effect.provide(layer));
    }
  }),
);

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "succeeded";

it.effect("sign-in makes a key, connects it, keeps no token; disconnect revokes it", () => {
  const slowDown = { status: 400, body: { error: "slow_down" } };
  const { secrets, cloud, layer } = setup({ tokenScript: [pending, slowDown, granted] });
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const signIn = yield* gateway.signInStart("connect");
    assert.strictEqual(signIn.userCode, "ABCD-EFGH");
    assert.strictEqual((yield* gateway.status).signIn?.userCode, "ABCD-EFGH");
    const wait = yield* Effect.forkChild(gateway.signInWait);
    // 5 s: pending; 10 s: slow_down; then the interval is 10 s, so nothing at 15 s.
    yield* TestClock.adjust("10 seconds");
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual(cloud.filter((r) => r.url === "/v1/device/token").length, 2);
    yield* TestClock.adjust("5 seconds");
    const connected = yield* Fiber.join(wait);

    assert.isTrue(connected.connected);
    assert.deepStrictEqual(connected.account, { email: "jo@example.com", workspace: "Acme" });
    assert.isNull(connected.signIn);
    const create = cloud.find((r) => r.url === "/v1/gateway-keys");
    assert.strictEqual(create?.authorization, `Bearer ${SESSION_TOKEN}`);
    assert.include(create?.body ?? "", "LibraOS Next on testhost");
    assert.strictEqual(new TextDecoder().decode(secrets.get("libraos-gateway-key")), SIGNED_IN_KEY);
    for (const value of secrets.values()) {
      assert.notInclude(new TextDecoder().decode(value), SESSION_TOKEN);
    }
    // The same agents a pasted key adds, Pi included.
    const settings = yield* ServerSettingsService;
    const instances = (yield* settings.getSettings).providerInstances;
    for (const id of GATEWAY_INSTANCES) assert.property(instances, id);

    yield* gateway.signInStart("revoke");
    const revoking = yield* Effect.forkChild(gateway.signInWait);
    yield* TestClock.adjust("5 seconds");
    const disconnected = yield* Fiber.join(revoking);
    const revoke = cloud.find((r) => r.method === "DELETE");
    assert.strictEqual(revoke?.url, "/v1/gateway-keys/key_1");
    assert.strictEqual(revoke?.authorization, `Bearer ${SESSION_TOKEN}`);
    assert.isFalse(disconnected.connected);
    assert.strictEqual(disconnected.notice, "The key was revoked in LibraOS.");
    assert.strictEqual(secrets.size, 0);
    const remaining = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(remaining, id);
  }).pipe(Effect.provide(layer));
});

it.effect("denial, expiry and Cancel each end the wait and connect nothing", () =>
  Effect.gen(function* () {
    const cases = [
      {
        script: [pending, { status: 400, body: { error: "access_denied" } }],
        end: (_: LibraosGateway.LibraosGateway["Service"]) => TestClock.adjust("10 seconds"),
        says: "denied",
      },
      {
        script: [pending],
        end: (_: LibraosGateway.LibraosGateway["Service"]) => TestClock.adjust("65 seconds"),
        says: "expired",
      },
      {
        script: [pending],
        end: (gateway: LibraosGateway.LibraosGateway["Service"]) => gateway.signInCancel,
        says: "cancelled",
      },
    ];
    for (const { script, end, says } of cases) {
      const { secrets, cloud, layer } = setup({ tokenScript: script });
      yield* Effect.gen(function* () {
        const gateway = yield* LibraosGateway.LibraosGateway;
        yield* gateway.signInStart("connect");
        const wait = yield* Effect.forkChild(gateway.signInWait);
        yield* TestClock.adjust("5 seconds");
        yield* end(gateway);
        const exit = yield* Effect.exit(Fiber.join(wait));
        assert.include(failureText(exit), says);
        const status = yield* gateway.status;
        assert.isFalse(status.connected);
        assert.isNull(status.signIn);
        assert.strictEqual(secrets.size, 0);
        assert.isUndefined(cloud.find((r) => r.url.startsWith("/v1/gateway-keys")));
      }).pipe(Effect.provide(layer));
    }
  }),
);

it.effect("a key the Gateway refuses after sign-in is revoked again in LibraOS", () => {
  const { secrets, cloud, layer } = setup({ createdKey: "lk_refused_key_0123456789" });
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    yield* gateway.signInStart("connect");
    const wait = yield* Effect.forkChild(gateway.signInWait);
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Effect.exit(Fiber.join(wait));
    assert.include(failureText(exit), "This API key is not valid.");
    assert.strictEqual(cloud.find((r) => r.method === "DELETE")?.url, "/v1/gateway-keys/key_1");
    assert.strictEqual(secrets.size, 0);
  }).pipe(Effect.provide(layer));
});
