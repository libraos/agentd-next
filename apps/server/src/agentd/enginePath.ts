import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

/** LibraOS Engine's command first, then its earlier names, all the same binary. */
const ENGINE_COMMANDS = ["libraos-engine", "libraos-core", "agentd"] as const;

/** Whether a program name a plugin runs is one of the engine's names. */
export function isEngineCommand(platform: NodeJS.Platform, name: string): boolean {
  const bare = platform === "win32" ? name.toLowerCase().replace(/\.exe$/, "") : name;
  return (ENGINE_COMMANDS as ReadonlyArray<string>).includes(bare);
}

/** The engine to run: AGENTD_BIN when set, else the first of its names on PATH; null when none is. */
export const findEngine = Effect.fn("agentd.findEngine")(function* (env: NodeJS.ProcessEnv) {
  const configured = env.AGENTD_BIN?.trim() || undefined;
  for (const name of configured === undefined ? ENGINE_COMMANDS : [configured]) {
    const found = yield* resolveCommandPath(name, { env });
    if (found !== null) return found;
  }
  return null;
});
