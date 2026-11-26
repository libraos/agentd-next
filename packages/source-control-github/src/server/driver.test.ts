import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { makeIsRepositoryStarred, makeRepositoryCredential, makeStarRepository } from "./driver.ts";
import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("starred", () => {
  it.effect("checks and stars only a valid repository, true only on 204", () => {
    const paths: Array<string> = [];
    const starred = new Set(["user/starred/pingdotgg/t3code"]);
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        paths.push(`${input.method ?? "GET"} ${input.path}`);
        return starred.has(input.path)
          ? Effect.succeed({
              status: 204,
              headers: {},
              body: "",
              truncated: false,
              invalidUtf8: false,
            })
          : Effect.fail(
              new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              }),
            );
      },
    });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      const star = yield* makeStarRepository;
      assert.isTrue(yield* isStarred("github.com", "pingdotgg/t3code"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/uploadthing"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/t3code/../../user"));
      assert.isFalse(yield* isStarred("github.com", "../repos"));
      assert.isTrue(yield* star("github.com", "pingdotgg/t3code"));
      assert.isFalse(yield* star("github.com", "pingdotgg/uploadthing"));
      assert.isFalse(yield* star("github.com", "pingdotgg/t3code/../../user"));
      assert.isFalse(yield* star("github.com", "../repos"));
      assert.deepStrictEqual(paths, [
        "GET user/starred/pingdotgg/t3code",
        "GET user/starred/pingdotgg/uploadthing",
        "PUT user/starred/pingdotgg/t3code",
        "PUT user/starred/pingdotgg/uploadthing",
      ]);
    }).pipe(Effect.provide(api));
  });
});

describe("repositoryCredential", () => {
  it.effect("gives the token credentialFor holds for that repository, none when it fails", () => {
    const asked: Array<string> = [];
    const access = Layer.mock(GitHubAppAccess.GitHubAppAccess)({
      credentialFor: (host, repository) => {
        asked.push(`${host} ${repository}`);
        return repository === "acme/private"
          ? Effect.succeed({ source: "app", token: Redacted.make("ghs_app"), fingerprint: "f" })
          : Effect.fail(new GitHubRequestPolicy.GitHubApiNotFoundError({ host, operation: "x" }));
      },
    });
    return Effect.gen(function* () {
      const credential = yield* makeRepositoryCredential;
      const held = yield* credential("github.com", "acme/private");
      assert.deepStrictEqual(Option.map(held, Redacted.value), Option.some("ghs_app"));
      assert.isTrue(Option.isNone(yield* credential("github.com", "acme/other")));
      assert.deepStrictEqual(asked, ["github.com acme/private", "github.com acme/other"]);
    }).pipe(Effect.provide(access));
  });
});
