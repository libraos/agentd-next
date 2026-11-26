import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";

/**
 * The server's GitHub connection (Settings, Source control) for reads pinned to one repository on
 * github.com: the GitHub App's token where an installation covers it, else the account's own.
 */
export class AgentdGitHubConnection extends Context.Service<
  AgentdGitHubConnection,
  {
    readonly credential: (
      repository: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  }
>()("t3/agentd/agentdGitHubConnection") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  const read = drivers.find(({ driver }) => driver.kind === "github")?.instance
    .repositoryCredential;
  return AgentdGitHubConnection.of({
    credential: Effect.fn("AgentdGitHubConnection.credential")(function* (repository: string) {
      return read === undefined ? Option.none() : yield* read("github.com", repository);
    }),
  });
});

// Needs the server's own SourceControlDrivers, so the connection is the one Source control uses.
export const layer = Layer.effect(AgentdGitHubConnection, make);
