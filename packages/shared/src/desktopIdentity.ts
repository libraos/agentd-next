/**
 * AgentD Next's own data folder, link scheme and command, apart from the upstream app on the same machine.
 * Folder, scheme and service names keep the legacy `agentd-desktop` so installs update in place.
 */

import * as Config from "effect/Config";
import * as Option from "effect/Option";

/** Production scheme; other channels add a suffix, such as `agentd-desktop-dev`. */
export const APP_LINK_SCHEME = "agentd-desktop";
export const APP_LINK_PROTOCOL = /^agentd-desktop(?:-[a-z]+)?:$/;
/** The command the app puts on PATH (`.cmd` on Windows). */
export const CLI_COMMAND_NAME = "libraos-next";
/** The legacy command name, from agentd.4 to agentd.6; an installed one is kept working and removed with the new one. */
export const LEGACY_CLI_COMMAND_NAME = "agentd-desktop";
/** Installed beside the command under the earlier names, so `agentd-next` and upstream's `t3` keep working. */
export const CLI_COMMAND_ALIASES = ["agentd-next", "t3"] as const;
/** Background service, Windows task, systemd slices and per-user folders; the upstream app's are `t3code`. */
export const OS_NAME = "agentd-desktop";
/** `.service` keeps it apart from the app's bundle id, `ai.libraos.agentd-desktop`. */
export const LAUNCHD_SERVICE_LABEL = "ai.libraos.agentd-desktop.service";

export const DESKTOP_HOME_DIRECTORY_NAME = ".agentd-desktop";
export const DESKTOP_HOME_ENV = "AGENTD_DESKTOP_HOME";
/** Read before the others, as every `LIBRAOS_NEXT_<NAME>` is read before `T3CODE_<NAME>`. */
const LIBRAOS_NEXT_HOME_ENV = "LIBRAOS_NEXT_HOME";
/** Upstream's name, still read when the new one is unset. */
const LEGACY_DESKTOP_HOME_ENV = "T3CODE_HOME";
/** In the order they are read. */
export const DESKTOP_HOME_ENV_NAMES = [
  LIBRAOS_NEXT_HOME_ENV,
  DESKTOP_HOME_ENV,
  LEGACY_DESKTOP_HOME_ENV,
] as const;

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const configuredDesktopHome = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  for (const name of DESKTOP_HOME_ENV_NAMES) {
    const value = nonBlank(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

export const defaultDesktopHome = (
  homeDirectory: string,
  join: (first: string, ...segments: string[]) => string,
): string => join(homeDirectory, DESKTOP_HOME_DIRECTORY_NAME);

/** The configured home, trimmed; blank counts as unset. */
export const DesktopHomeConfig: Config.Config<Option.Option<string>> = Config.all(
  DESKTOP_HOME_ENV_NAMES.map((name) => Config.String(name).pipe(Config.option)),
).pipe(
  Config.map((values) =>
    Option.fromUndefinedOr(
      configuredDesktopHome(
        Object.fromEntries(
          DESKTOP_HOME_ENV_NAMES.map((name, index) => [
            name,
            Option.getOrUndefined(values[index]!),
          ]),
        ),
      ),
    ),
  ),
);
