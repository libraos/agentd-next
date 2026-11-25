import {
  gitHubCliInstallHint,
  gitLabCliInstallHint,
  jujutsuInstallHint,
} from "@t3tools/source-control-core/shared/installHints";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlInstallHintText } from "./contractLabels.ts";

describe("sourceControlInstallHintText", () => {
  const hints = [jujutsuInstallHint, gitHubCliInstallHint, gitLabCliInstallHint];

  it.each(["darwin", "linux", "win32"])("translates every %s install hint", (platform) => {
    for (const hint of hints.map((forPlatform) => forPlatform(platform))) {
      // Unknown hints come back as is without reaching the translator.
      let translated = 0;
      const resolve: MFunctionType = (encoded, options) => {
        translated += 1;
        return mFallback(encoded, options);
      };
      expect(sourceControlInstallHintText(hint, resolve)).toBe(hint);
      expect(translated, hint).toBe(1);
    }
  });

  it.each(["linux", "win32"])("offers no Homebrew command on %s", (platform) => {
    for (const hint of hints.map((forPlatform) => forPlatform(platform))) {
      expect(hint).not.toContain("brew");
    }
  });
});
