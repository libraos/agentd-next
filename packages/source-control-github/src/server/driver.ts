import { SourceControlSignInError, type SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlDriver,
  withOwnServices,
  type SourceControlSignIn,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import { definition } from "../shared/definition.ts";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubHttpClient from "./GitHubHttpClient.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// `GitHubRest.layerWithDependencies` carries the quota reserve every GitHub reader shares, so it
// must be built once; the driver is.
const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubAppAccess.layer),
  Layer.provideMerge(GitHubRest.layerWithDependencies),
  Layer.provideMerge(GitHubHttpClient.layer),
);

const makeSignIn = Effect.gen(function* () {
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
  const kind: SourceControlProviderKind = definition.kind;
  return {
    start: appSignIn.start,
    wait: (host) =>
      appSignIn.wait(host).pipe(
        Effect.andThen(
          appAccess.viewer(host).pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlSignInError({
                  provider: kind,
                  host,
                  reason: "failed",
                  detail: "Signed in, but GitHub would not say which account it belongs to.",
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((account) => ({ account })),
      ),
    cancel: appSignIn.cancel,
    access: appAccess.reach,
  } satisfies SourceControlSignIn;
});

const starredPath = (repository: string) => {
  const segments = repository.split("/");
  // "." and ".." survive encoding and would normalize the URL out of user/starred.
  return segments.length === 2 && segments.every((segment) => !["", ".", ".."].includes(segment))
    ? `user/starred/${segments.map(encodeURIComponent).join("/")}`
    : undefined;
};

// Only 204 means starred. Tokens without star access, a missing login, and 404 all read as false.
export const makeIsRepositoryStarred = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.isRepositoryStarred")(
    function* (host: string, repository: string) {
      const path = starredPath(repository);
      if (path === undefined) return false;
      const response = yield* api.rest({
        host,
        operation: "isRepositoryStarred",
        path,
        allowReserve: false,
      });
      return response.status === 204;
    },
    Effect.orElseSucceed(() => false),
  );
});

// False on any failure, such as a token or app sign-in without permission to star.
export const makeStarRepository = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.starRepository")(
    function* (host: string, repository: string) {
      const path = starredPath(repository);
      if (path === undefined) return false;
      const response = yield* api.rest({ host, operation: "starRepository", method: "PUT", path });
      return response.status === 204;
    },
    Effect.orElseSucceed(() => false),
  );
});

// The app's token where an installation covers the repository, else the user's own; for reads
// pinned to that repository, such as a private plugin catalogue.
export const makeRepositoryCredential = Effect.gen(function* () {
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
  return (host: string, repository: string) =>
    appAccess.credentialFor(host, repository).pipe(
      Effect.map((held) => Option.some(held.token)),
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
    );
});

const makeInstance = Effect.gen(function* () {
  const mediaHttpClient = yield* HttpClient.HttpClient;
  return yield* withOwnServices(
    Effect.all({
      sourceControl: GitHubSourceControlProvider.make,
      discovery: GitHubSourceControlProvider.makeDiscovery,
      pullRequests: GitHubPullRequestProvider.make,
      issues: GitHubIssueTracker.make,
      fetchMedia: GitHubMediaFetch.make.pipe(
        Effect.provideService(HttpClient.HttpClient, mediaHttpClient),
      ),
      signIn: makeSignIn,
      isRepositoryStarred: makeIsRepositoryStarred,
      starRepository: makeStarRepository,
      repositoryCredential: makeRepositoryCredential,
    }),
    services,
  );
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: makeInstance,
});
