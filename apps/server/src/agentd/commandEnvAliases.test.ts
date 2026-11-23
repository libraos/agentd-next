import { expect, it } from "@effect/vitest";
import { DesktopHomeConfig } from "@t3tools/shared/desktopIdentity";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { applyCommandEnvAliases } from "./commandEnvAliases.ts";

it.effect.each([
  {
    label: "the new name wins over the old one",
    platform: "linux" as const,
    env: { LIBRAOS_NEXT_PORT: "4000", T3CODE_PORT: "3000", T3CODE_MODE: "web" },
    expected: { T3CODE_PORT: "4000", T3CODE_MODE: "web" },
  },
  {
    label: "the old name alone still counts",
    platform: "linux" as const,
    env: { T3CODE_PORT: "3000" },
    expected: { T3CODE_PORT: "3000" },
  },
  {
    label: "a lowercase prefix is another variable on POSIX",
    platform: "linux" as const,
    env: { libraos_next_PORT: "4000", T3CODE_PORT: "3000" },
    expected: { T3CODE_PORT: "3000" },
  },
  {
    label: "Windows names are case-insensitive",
    platform: "win32" as const,
    env: { Libraos_Next_PORT: "4000" },
    expected: { T3CODE_PORT: "4000" },
  },
])("reads LIBRAOS_NEXT_<NAME> first: $label", ({ platform, env, expected }) =>
  Effect.sync(() => {
    const copy: Record<string, string | undefined> = { ...env };
    applyCommandEnvAliases(copy, platform);
    expect(copy).toMatchObject(expected);
  }),
);

it.effect("finds the home under LIBRAOS_NEXT_HOME before the earlier names", () =>
  Effect.gen(function* () {
    const home = (env: Record<string, string>) =>
      DesktopHomeConfig.parse(ConfigProvider.fromEnv({ env })).pipe(Effect.map(Option.getOrNull));
    const all = { AGENTD_DESKTOP_HOME: "/desktop", T3CODE_HOME: "/t3" };
    expect(yield* home({ ...all, LIBRAOS_NEXT_HOME: "/libraos" })).toBe("/libraos");
    // Blank counts as unset, as it does for the earlier names.
    expect(yield* home({ ...all, LIBRAOS_NEXT_HOME: " " })).toBe("/desktop");
    expect(yield* home({ T3CODE_HOME: "/t3" })).toBe("/t3");
  }),
);
