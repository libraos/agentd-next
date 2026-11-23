/**
 * LibraOS Next's own data folder, link scheme and command, apart from the upstream app on the same machine.
 * Folder and service names keep the legacy `agentd-desktop` so installs update in place.
 */

import * as Config from "effect/Config";
import * as Option from "effect/Option";

/** Scheme of the links the app builds; other channels add a suffix, such as `libraos-next-dev`. */
export const APP_LINK_SCHEME = "libraos-next";
/**
 * AgentD Next's scheme. Its links still open the app, and it stays the renderer's origin
 * (`agentd-desktop://app`) so stored browser data, sign-in and older servers' CORS keep working.
 */
export const LEGACY_APP_LINK_SCHEME = "agentd-desktop";
export const APP_LINK_PROTOCOL = /^(?:libraos-next|agentd-desktop)(?:-[a-z]+)?:$/;
/** Every scheme the OS hands to the app on one channel, the current one first. */
export const appLinkSchemes = (development: boolean): readonly [string, string] => {
  const suffix = development ? "-dev" : "";
  return [`${APP_LINK_SCHEME}${suffix}`, `${LEGACY_APP_LINK_SCHEME}${suffix}`];
};
/** The command the app puts on PATH (`.cmd` on Windows). */
export const CLI_COMMAND_NAME = "agentd-next";
/** The legacy command name, from agentd.4 to agentd.6; an installed one is kept working and removed with the new one. */
export const LEGACY_CLI_COMMAND_NAME = "agentd-desktop";
/** Installed beside the command so scripts written for upstream's `t3` keep working. */
export const CLI_COMMAND_ALIAS = "t3";
/** Background service, Windows task, systemd slices and per-user folders; the upstream app's are `t3code`. */
export const OS_NAME = "agentd-desktop";
/** AgentD Next's bundle id plus `.service`; kept so existing installs keep their background service. */
export const LAUNCHD_SERVICE_LABEL = "ai.libraos.agentd-desktop.service";

export const DESKTOP_HOME_DIRECTORY_NAME = ".agentd-desktop";
export const DESKTOP_HOME_ENV = "AGENTD_DESKTOP_HOME";
/** Upstream's name, still read when the new one is unset. */
const LEGACY_DESKTOP_HOME_ENV = "T3CODE_HOME";
export const DESKTOP_HOME_ENV_NAMES = [DESKTOP_HOME_ENV, LEGACY_DESKTOP_HOME_ENV] as const;

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const configuredDesktopHome = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => nonBlank(env[DESKTOP_HOME_ENV]) ?? nonBlank(env[LEGACY_DESKTOP_HOME_ENV]);

export const defaultDesktopHome = (
  homeDirectory: string,
  join: (first: string, ...segments: string[]) => string,
): string => join(homeDirectory, DESKTOP_HOME_DIRECTORY_NAME);

/** The configured home, trimmed; blank counts as unset. */
export const DesktopHomeConfig: Config.Config<Option.Option<string>> = Config.all({
  [DESKTOP_HOME_ENV]: Config.String(DESKTOP_HOME_ENV).pipe(Config.option),
  [LEGACY_DESKTOP_HOME_ENV]: Config.String(LEGACY_DESKTOP_HOME_ENV).pipe(Config.option),
}).pipe(
  Config.map((values) =>
    Option.fromUndefinedOr(
      configuredDesktopHome({
        [DESKTOP_HOME_ENV]: Option.getOrUndefined(values[DESKTOP_HOME_ENV]),
        [LEGACY_DESKTOP_HOME_ENV]: Option.getOrUndefined(values[LEGACY_DESKTOP_HOME_ENV]),
      }),
    ),
  ),
);
