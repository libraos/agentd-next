/** The command's own prefix: `LIBRAOS_NEXT_<NAME>` is read before upstream's `T3CODE_<NAME>`. */
const COMMAND_ENV_PREFIX = "LIBRAOS_NEXT_";
const LEGACY_ENV_PREFIX = "T3CODE_";

/**
 * Copies each `LIBRAOS_NEXT_<NAME>` over `T3CODE_<NAME>` before anything reads the environment,
 * so every setting and every child process sees one value, whichever name the user set.
 */
export function applyCommandEnvAliases(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  for (const [key, value] of Object.entries(env)) {
    // Windows variable names are case-insensitive, as its lookups of the old names are.
    const spelled = platform === "win32" ? key.toUpperCase() : key;
    if (value === undefined || !spelled.startsWith(COMMAND_ENV_PREFIX)) continue;
    const name = key.slice(COMMAND_ENV_PREFIX.length);
    if (name.length > 0) env[`${LEGACY_ENV_PREFIX}${name}`] = value;
  }
}
