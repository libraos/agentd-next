import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CustomGateway from "./CustomGateway.ts";
import { gatewayProviderInstances } from "./gatewaySetup.ts";

const URL = "https://gw.example.com";

const instance = (settings: ServerSettings, id: string) =>
  settings.providerInstances[ProviderInstanceId.make(id)];

function setup(answer: () => Response) {
  const secrets = new Map<string, Uint8Array>();
  const asked: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      asked.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(request, answer());
    }),
  );
  // The user's own Codex agent and a connected LibraOS Gateway, which a custom gateway leaves be.
  const own = {
    codex: { driver: "codex", displayName: "My Codex", enabled: true, config: {} },
    ...Object.fromEntries(
      gatewayProviderInstances("lk_test_key_123456", [{ id: "openai/gpt-5.5" }], "/pi").map(
        ({ instanceId, instance }) => [instanceId, instance],
      ),
    ),
  };
  const layer = Layer.effect(CustomGateway.CustomGateway, CustomGateway.make()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(HttpClient.HttpClient, http),
        ServerSettingsService.layerTest({ providerInstances: own as never }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-custom-gateway-test-" }),
        // No other agent on the host, so a gateway's Pi agent becomes the first-run default.
        Layer.succeed(CommandAvailability, () => Effect.succeed(false)),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { secrets, asked, own, layer };
}

const served = () => Response.json({ data: [{ id: "m1" }] });

it.effect("add leaves the models a gateway marks as video or audio out of chat", () => {
  const { layer } = setup(() =>
    Response.json({
      data: [{ id: "m1" }, { id: "minimax-h3", type: "video" }, { id: "tts-1", type: "audio" }],
    }),
  );
  return Effect.gen(function* () {
    const result = yield* (yield* CustomGateway.CustomGateway).add({
      url: URL,
      format: "openai",
      key: "k1",
      name: "GW",
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    assert.strictEqual(result.gateway.modelCount, 1);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const codex = instance(settings, `gw-${result.gateway.id}-codex`);
    assert.deepStrictEqual(
      (codex?.config as { customModels?: unknown } | undefined)?.customModels,
      [{ slug: "m1" }],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("add makes only the agents asked for", () => {
  const { layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({
      url: URL,
      format: "openai",
      key: "k1",
      agents: ["opencode"],
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    const id = result.gateway.id;
    const instances = Object.keys(
      (yield* (yield* ServerSettingsService).getSettings).providerInstances,
    );
    assert.include(instances, `gw-${id}-opencode`);
    assert.notInclude(instances, `gw-${id}-codex`);
    assert.deepStrictEqual((yield* gateways.list).gateways, [
      {
        id,
        name: URL,
        url: URL,
        format: "openai",
        hasKey: true,
        agents: ["opencode"],
        modelCount: 1,
        models: ["m1"],
        hiddenModels: [],
      },
    ]);
    const none = yield* gateways
      .add({ url: URL, format: "openai", key: "k1", agents: ["claude"] })
      .pipe(Effect.flip);
    assert.strictEqual(none.message, "Pick at least one agent that works with this format.");
  }).pipe(Effect.provide(layer));
});

it.effect("add names the gateway after its url", () => {
  const { secrets, asked, layer } = setup(served);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({
      url: `${URL}/`,
      format: "openai",
      key: " k1 ",
      name: " ",
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    assert.deepInclude(result.gateway, { name: URL, url: URL, hasKey: true, modelCount: 1 });
    assert.deepStrictEqual(asked, [{ url: `${URL}/v1/models`, authorization: "Bearer k1" }]);
    const id = result.gateway.id;
    assert.match(id, /^[a-z0-9]{8}$/);
    assert.strictEqual(new TextDecoder().decode(secrets.get(`custom-gateway-key-${id}`)), "k1");
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(settings.customGateways, [
      { id, name: URL, url: URL, format: "openai" },
    ]);
    const instances = Object.keys(settings.providerInstances);
    assert.include(instances, `gw-${id}-codex`);
    assert.include(instances, `gw-${id}-opencode`);
    assert.include(instances, `gw-${id}-pi`);
    assert.notInclude(instances, `gw-${id}-claude`);
    assert.deepStrictEqual(result.gateway.agents, ["codex", "opencode", "pi"]);
    assert.deepStrictEqual(yield* gateways.list, { gateways: [result.gateway] });

    // Pi reaches this gateway alone; models.json names the key's variable, not the key.
    const piDir = path.join(
      (yield* ServerConfig.ServerConfig).stateDir,
      "pi-gateway",
      `gw-${id}-pi`,
    );
    const pi = instance(settings, `gw-${id}-pi`);
    assert.strictEqual(pi?.displayName, `Pi · ${URL}`);
    assert.deepStrictEqual(pi?.environment, [
      { name: "CUSTOM_GATEWAY_API_KEY", value: "k1", sensitive: true },
      { name: "PI_CODING_AGENT_DIR", value: piDir, sensitive: false },
    ]);
    assert.deepStrictEqual(pi?.config, { customModels: [{ slug: `gw_${id}/m1` }] });
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(path.join(piDir, "models.json"))), {
      providers: {
        [`gw_${id}`]: {
          baseUrl: `${URL}/v1`,
          api: "openai-completions",
          apiKey: "$CUSTOM_GATEWAY_API_KEY",
          models: [{ id: "m1" }],
        },
      },
    });
    assert.deepStrictEqual(settings.defaultModelSelection, {
      instanceId: ProviderInstanceId.make(`gw-${id}-pi`),
      model: "default",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("a refused model list is redacted and nothing is saved", () => {
  const { secrets, own, layer } = setup(() =>
    Response.json(
      { error: { message: "bad key sk-abcdef123456 or my-secret-key-9" } },
      { status: 401 },
    ),
  );
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({ url: URL, format: "openai", key: "my-secret-key-9" });
    assert.strictEqual(result.kind, "modelsProblem");
    if (result.kind !== "modelsProblem") return;
    assert.strictEqual(result.message, "bad key [redacted] or [redacted]");
    assert.strictEqual(secrets.size, 0);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(settings.customGateways, []);
    assert.deepStrictEqual(Object.keys(settings.providerInstances), Object.keys(own));
  }).pipe(Effect.provide(layer));
});

it.effect("typed ids save without asking", () => {
  const { asked, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({
      url: URL,
      format: "anthropic",
      key: "k1",
      models: ["a", " b ", "", "a"],
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    assert.deepInclude(result.gateway, { hasKey: true, modelCount: 2 });
    assert.strictEqual(asked.length, 0);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(instance(settings, `gw-${result.gateway.id}-claude`)?.config, {
      customModels: [{ slug: "a" }, { slug: "b" }],
      onlyCustomModels: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("an anthropic gateway without a key is refused and nothing is saved", () => {
  const { asked, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const error = yield* Effect.flip(
      gateways.add({ url: URL, format: "anthropic", key: "  ", models: ["a"] }),
    );
    assert.include(error.message, "needs a key");
    assert.strictEqual(asked.length, 0);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(settings.customGateways, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a model turned off leaves every agent of the gateway and stays off after a refresh",
  () => {
    const { layer } = setup(() =>
      Response.json({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
    );
    return Effect.gen(function* () {
      const gateways = yield* CustomGateway.CustomGateway;
      const added = yield* gateways.add({ url: URL, format: "openai", key: "k1", name: "Work" });
      if (added.kind !== "added") return assert.fail(added.message);
      const id = added.gateway.id;
      const offered = Effect.gen(function* () {
        const settings = yield* (yield* ServerSettingsService).getSettings;
        const codex = instance(settings, `gw-${id}-codex`)?.config as
          | { customModels?: ReadonlyArray<{ slug: string }> }
          | undefined;
        const opencode = JSON.parse(
          String(
            instance(settings, `gw-${id}-opencode`)?.environment?.find(
              (variable) => variable.name === "OPENCODE_CONFIG_CONTENT",
            )?.value,
          ),
        ) as { provider: Record<string, { models: Record<string, unknown> }> };
        const piDir = String(
          instance(settings, `gw-${id}-pi`)?.environment?.find(
            (variable) => variable.name === "PI_CODING_AGENT_DIR",
          )?.value,
        );
        const fs = yield* FileSystem.FileSystem;
        const modelsJson = JSON.parse(yield* fs.readFileString(`${piDir}/models.json`)) as {
          providers: Record<string, { models: ReadonlyArray<{ id: string }> }>;
        };
        const pi = instance(settings, `gw-${id}-pi`)?.config as {
          customModels: ReadonlyArray<{ slug: string }>;
        };
        assert.deepStrictEqual(
          pi.customModels.map((model) => model.slug),
          modelsJson.providers[`gw_${id}`]!.models.map((model) => `gw_${id}/${model.id}`),
        );
        return {
          codex: codex?.customModels?.map((model) => model.slug),
          opencode: Object.keys(opencode.provider[`gw_${id}`]!.models),
          pi: modelsJson.providers[`gw_${id}`]!.models.map((model) => model.id),
        };
      });

      const listed = yield* gateways.setHiddenModels(id, ["m2"]);
      assert.deepStrictEqual(listed.gateways[0]?.models, ["m1", "m3"]);
      assert.deepStrictEqual(listed.gateways[0]?.hiddenModels, ["m2"]);
      const twoOf3 = { codex: ["m1", "m3"], opencode: ["m1", "m3"], pi: ["m1", "m3"] };
      assert.deepStrictEqual(yield* offered, twoOf3);

      yield* gateways.refreshModels(id);
      assert.deepStrictEqual(yield* offered, twoOf3);

      const restored = yield* gateways.setHiddenModels(id, []);
      assert.deepStrictEqual([...(restored.gateways[0]?.models ?? [])].sort(), ["m1", "m2", "m3"]);

      const none = yield* gateways.setHiddenModels(id, ["m1", "m2", "m3"]).pipe(Effect.flip);
      assert.strictEqual(none.message, "Keep at least one model on.");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rename to blank falls back to the url", () => {
  const { layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const added = yield* gateways.add({ url: URL, format: "openai", key: "k1", name: "Work" });
    if (added.kind !== "added") return assert.fail(added.message);
    const id = added.gateway.id;
    const listed = yield* gateways.rename(id, "  ");
    assert.strictEqual(listed.gateways[0]?.name, URL);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.strictEqual(settings.customGateways[0]?.name, URL);
    assert.strictEqual(instance(settings, `gw-${id}-codex`)?.displayName, `Codex · ${URL}`);
    assert.strictEqual(instance(settings, `gw-${id}-opencode`)?.displayName, `opencode · ${URL}`);
    assert.strictEqual(instance(settings, `gw-${id}-pi`)?.displayName, `Pi · ${URL}`);
  }).pipe(Effect.provide(layer));
});

it.effect("each gateway's agents get a color of their own", () => {
  const { layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const first = yield* gateways.add({ url: URL, format: "openai", key: "k1" });
    const second = yield* gateways.add({
      url: "http://localhost:4000",
      format: "openai",
      key: "k2",
    });
    if (first.kind !== "added" || second.kind !== "added") return assert.fail("not added");
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const color = (id: string, agent: string) =>
      instance(settings, `gw-${id}-${agent}`)?.accentColor;
    assert.deepStrictEqual(
      [
        color(first.gateway.id, "codex"),
        color(first.gateway.id, "opencode"),
        color(second.gateway.id, "codex"),
      ],
      ["#2563eb", "#2563eb", "#16a34a"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("remove leaves the other gateway and the user's instances", () => {
  const { secrets, own, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const first = yield* gateways.add({ url: URL, format: "openai", key: "k1" });
    const second = yield* gateways.add({
      url: "http://localhost:4000",
      format: "anthropic",
      key: "k2",
    });
    if (first.kind !== "added" || second.kind !== "added") return assert.fail("not added");
    const before = (yield* (yield* ServerSettingsService).getSettings).providerInstances;
    const piDir = String(
      before[ProviderInstanceId.make(`gw-${first.gateway.id}-pi`)]?.environment?.find(
        (variable) => variable.name === "PI_CODING_AGENT_DIR",
      )?.value,
    );
    const fs = yield* FileSystem.FileSystem;
    assert.isTrue(yield* fs.exists(piDir));

    const listed = yield* gateways.remove(first.gateway.id);
    assert.deepStrictEqual(listed, { gateways: [second.gateway] });
    const after = (yield* (yield* ServerSettingsService).getSettings).providerInstances;
    const secondIds = [`gw-${second.gateway.id}-claude`, `gw-${second.gateway.id}-opencode`];
    assert.deepStrictEqual(
      Object.keys(after).toSorted(),
      [...Object.keys(own), ...secondIds].toSorted(),
    );
    for (const id of [...Object.keys(own), ...secondIds])
      assert.deepStrictEqual(
        after[ProviderInstanceId.make(id)],
        before[ProviderInstanceId.make(id)],
      );
    assert.deepStrictEqual([...secrets.keys()], [`custom-gateway-key-${second.gateway.id}`]);
    assert.isFalse(yield* fs.exists(piDir));
    // The default pointed at the removed gateway's Pi agent, so it goes too.
    assert.isNull((yield* (yield* ServerSettingsService).getSettings).defaultModelSelection);
  }).pipe(Effect.provide(layer));
});
