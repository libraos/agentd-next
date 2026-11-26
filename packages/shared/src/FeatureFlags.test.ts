import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FeatureFlags from "./FeatureFlags.ts";
import * as HostProcess from "./HostProcess.ts";

const DEFAULT_CLIENT_ID = Option.some(FeatureFlags.LIBRAOS_NEXT_GITHUB_APP_CLIENT_ID);

it.effect("resolves T3CODE_FEATURE_FLAGS lists", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [string | undefined, Partial<FeatureFlags.FeatureFlagValues>]
    > = [
      [undefined, {}],
      [" tanstack_source , secret_providers=1 ", { tanstackSource: true, secretProviders: true }],
      [
        "tanstack_source=0,github_app_client_id=Iv23=x",
        { githubAppClientId: Option.some("Iv23=x") },
      ],
      ["tanstack_source,typo_flag", { tanstackSource: true }],
      // One bad value turns every flag off rather than failing startup.
      ["tanstack_source,secret_providers=maybe", {}],
    ];
    for (const [list, expected] of cases) {
      assert.deepStrictEqual(yield* FeatureFlags.resolve(list), {
        secretProviders: false,
        tanstackSource: false,
        githubAppClientId: DEFAULT_CLIENT_ID,
        ...expected,
      });
    }
  }),
);

it.effect("signs in with the LibraOS Next app when nothing sets a client ID", () =>
  Effect.gen(function* () {
    assert.strictEqual(FeatureFlags.LIBRAOS_NEXT_GITHUB_APP_CLIENT_ID, "Iv23li6cv5OFAEY0qoob");
    const flags = yield* Effect.service(FeatureFlags.FeatureFlags).pipe(
      Effect.provide(FeatureFlags.layer),
      Effect.provideService(HostProcess.Environment, {}),
    );
    assert.deepStrictEqual(flags.githubAppClientId, DEFAULT_CLIENT_ID);
  }),
);

it.effect("an explicitly empty client ID keeps sign-in off", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      (yield* FeatureFlags.resolve("github_app_client_id=")).githubAppClientId,
      Option.some(""),
    );
    assert.deepStrictEqual(
      (yield* FeatureFlags.resolve(undefined, " ")).githubAppClientId,
      Option.some(""),
    );
    assert.deepStrictEqual(
      (yield* FeatureFlags.resolve("github_app_client_id=", "Iv23legacy")).githubAppClientId,
      Option.some(""),
    );
  }),
);

it.effect("falls back to T3CODE_GITHUB_APP_CLIENT_ID when the flag is unset", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      (yield* FeatureFlags.resolve(undefined, " Iv23legacy ")).githubAppClientId,
      Option.some("Iv23legacy"),
    );
    assert.deepStrictEqual(
      (yield* FeatureFlags.resolve("github_app_client_id=Iv23flag", "Iv23legacy"))
        .githubAppClientId,
      Option.some("Iv23flag"),
    );
    const flags = yield* Effect.service(FeatureFlags.FeatureFlags).pipe(
      Effect.provide(FeatureFlags.layer),
      Effect.provideService(HostProcess.Environment, {
        T3CODE_GITHUB_APP_CLIENT_ID: "Iv23other",
      }),
    );
    assert.deepStrictEqual(flags.githubAppClientId, Option.some("Iv23other"));
  }),
);
