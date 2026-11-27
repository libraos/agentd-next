import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderSkillSwitch } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";

import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { ProviderDriverError } from "../provider/Errors.ts";

export interface CodexSkillLaunch {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

/** A Codex instance's skill switch: each write runs a short-lived app-server, as the instance launches one. */
export function codexSkillSwitch<E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly configFile: string;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly launch: Effect.Effect<CodexSkillLaunch, E, Scope.Scope>;
}): ProviderSkillSwitch {
  return {
    kind: "codexAppServer",
    configFile: input.configFile,
    write: Effect.fn("codexSkillSwitch.write")(
      function* (skill) {
        const launch = yield* input.launch;
        const { client } = yield* withCodexAppServerClient({ ...launch, cwd: process.cwd() });
        const response = yield* client.request("skills/config/write", {
          path: skill.path,
          enabled: skill.enabled,
        });
        return response.effectiveEnabled;
      },
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: ProviderDriverKind.make("codex"),
            instanceId: input.instanceId,
            detail: "Codex could not change the skill's setting.",
            cause,
          }),
      ),
    ),
  };
}
