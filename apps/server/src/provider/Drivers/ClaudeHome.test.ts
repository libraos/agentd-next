import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("keeps a gateway's Claude apart from the login on the same home", () =>
      Effect.gen(function* () {
        const home = { CLAUDE_CONFIG_DIR: "/tmp/claude-shared" };
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, home)).toBe(
          "claude:home:/tmp/claude-shared",
        );
        expect(
          yield* makeClaudeContinuationGroupKey(
            { homePath: "" },
            { ...home, ANTHROPIC_BASE_URL: "https://gw.example.com" },
          ),
        ).toBe("claude:home:/tmp/claude-shared:endpoint:https://gw.example.com");
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes agentd-next unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "agentd-next",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );

  it.effect("keeps the picked model on a Claude Code sent to the Gateway by hand", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      const keepModel = {
        CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: "1",
        CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
      };
      const instance = [
        { name: "ANTHROPIC_BASE_URL", value: "https://api.libraos.com/", sensitive: false },
      ];
      expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, {})).toMatchObject(
        keepModel,
      );
      // An explicit value stays the user's.
      const explicit = [
        ...instance,
        { name: "CLAUDE_CODE_NO_MODEL_FALLBACK", value: "0", sensitive: false },
      ];
      expect(
        (yield* mergeClaudeProcessEnvironment({ homePath }, explicit, {}))
          .CLAUDE_CODE_NO_MODEL_FALLBACK,
      ).toBe("0");
      // Another endpoint keeps Claude Code's own behaviour.
      const other = yield* mergeClaudeProcessEnvironment({ homePath }, undefined, {
        ANTHROPIC_BASE_URL: "https://hub.example.com",
      });
      expect(other.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP).toBeUndefined();

      // The endpoint set in Claude Code's own settings counts too.
      yield* fileSystem.writeFileString(
        path.join(homePath, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.libraos.com" } }),
      );
      expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, {})).toMatchObject(
        keepModel,
      );
    }),
  );
});
