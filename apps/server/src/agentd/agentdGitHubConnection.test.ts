import { expect, it } from "@effect/vitest";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as AgentdGitHubConnection from "./agentdGitHubConnection.ts";

const read = (drivers: ReadonlyArray<SourceControlBuiltInDrivers.SourceControlDriverEntry>) =>
  Effect.gen(function* () {
    const connection = yield* AgentdGitHubConnection.AgentdGitHubConnection;
    return yield* connection.credential("acme/private");
  }).pipe(
    Effect.provide(
      AgentdGitHubConnection.layer.pipe(
        Layer.provide(Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, drivers)),
      ),
    ),
  );

const entry = (kind: string, instance: Partial<SourceControlDriverInstance>) =>
  ({
    driver: { kind },
    instance,
  }) as unknown as SourceControlBuiltInDrivers.SourceControlDriverEntry;

it.effect("asks the GitHub driver's connection for github.com and that repository only", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const credential = yield* read([
      entry("gitlab", {
        repositoryCredential: () => Effect.succeedSome(Redacted.make("not-github")),
      }),
      entry("github", {
        repositoryCredential: (host, repository) =>
          Effect.sync(() => {
            asked.push(`${host} ${repository}`);
            return Option.some(Redacted.make("ghs_TOKEN"));
          }),
      }),
    ]);
    expect(Option.map(credential, Redacted.value)).toEqual(Option.some("ghs_TOKEN"));
    expect(asked).toEqual(["github.com acme/private"]);
  }),
);

it.effect("has nothing when no GitHub driver can give a credential", () =>
  Effect.gen(function* () {
    expect(Option.isNone(yield* read([]))).toBe(true);
    expect(Option.isNone(yield* read([entry("github", {})]))).toBe(true);
  }),
);
