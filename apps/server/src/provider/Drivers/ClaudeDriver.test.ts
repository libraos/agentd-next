import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ProviderInstallationGate from "../ProviderInstallationGate.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-driver-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(PortScanner.layerTest),
  Layer.provideMerge(Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({})),
  Layer.provideMerge(ProviderInstallationGate.layer),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Claude must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Claude must not spawn a process"),
);

it.layer(layerTest)("ClaudeDriver", (it) => {
  it.effect("limits a Gateway agent saved by an older build to its key's models", () =>
    Effect.gen(function* () {
      const snapshot = (instanceId: string) =>
        ClaudeDriver.create({
          instanceId: ProviderInstanceId.make(instanceId),
          displayName: instanceId,
          enabled: false,
          environment: [],
          // No `onlyCustomModels`, as an older build saved it.
          config: {
            ...ClaudeDriver.defaultConfig(),
            customModels: [
              { slug: "claude-opus-5-5" },
              { slug: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro", subProvider: "gemini" },
              { slug: "anthropic/claude-sonnet-4-6", subProvider: "anthropic" },
            ],
          },
        }).pipe(Effect.flatMap((instance) => instance.snapshot.getSnapshot));

      // Claude's own model keeps its catalog entry; another family's sits under its family.
      const gateway = yield* snapshot("libraosClaude");
      expect(
        gateway.models.map((model) => [model.slug, model.isCustom, model.subProvider]),
      ).toEqual([
        ["claude-opus-5-5", false, undefined],
        ["gemini/gemini-2.5-pro", true, "gemini"],
        ["anthropic/claude-sonnet-4-6", true, "anthropic"],
      ]);
      expect(gateway.models[0]?.capabilities?.optionDescriptors?.length).toBeGreaterThan(0);
      // A full id shows the controls its turns compile with: effort, but not the suffix-only 1M.
      const fullIdOptions = gateway.models[2]?.capabilities?.optionDescriptors?.map(
        (descriptor) => descriptor.id,
      );
      expect(fullIdOptions).toContain("effort");
      expect(fullIdOptions).not.toContain("contextWindow");
      const own = yield* snapshot("claudeAgent");
      expect(own.models.length).toBeGreaterThan(1);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );
});
