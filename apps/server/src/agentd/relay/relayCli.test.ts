// @effect-diagnostics nodeBuiltinImport:off - checks the files and modes `relay connect` writes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../../binCli.ts";
import { readRelayConfig } from "./relayStore.ts";
import { startTestRelay, TEST_HOST_ID, TEST_HOST_TOKEN } from "./testRelay.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  );

const withRelayAndBaseDir = <A, E, R>(
  use: (input: { readonly relayUrl: string; readonly baseDir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => ({
      relay: await startTestRelay(),
      baseDir: await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "relay-cli-")),
    })),
    ({ relay, baseDir }) => use({ relayUrl: relay.url, baseDir }),
    ({ relay, baseDir }) =>
      Effect.promise(async () => {
        await relay.close();
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }),
  );

describe("lnext relay", () => {
  it.effect("connect checks the token with the relay and stores it for this user only", () =>
    withRelayAndBaseDir(({ relayUrl, baseDir }) =>
      Effect.gen(function* () {
        yield* runCli([
          "relay",
          "connect",
          relayUrl,
          "--token",
          TEST_HOST_TOKEN,
          "--base-dir",
          baseDir,
        ]);
        const stateDir = NodePath.join(baseDir, "userdata");
        const config = yield* Effect.promise(() => readRelayConfig(stateDir));
        assert.deepStrictEqual(config, {
          relayUrl,
          token: TEST_HOST_TOKEN,
          hostId: TEST_HOST_ID,
        });
        if (!windowsHost) {
          for (const file of ["relay.json", "host-key"]) {
            const stat = yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(stateDir, "relay", file)),
            );
            assert.strictEqual(stat.mode & 0o777, 0o600, file);
          }
        }

        yield* runCli(["relay", "disconnect", "--base-dir", baseDir]);
        assert.strictEqual(yield* Effect.promise(() => readRelayConfig(stateDir)), null);
      }),
    ),
  );

  it.effect("connect stores nothing when the relay refuses the token", () =>
    withRelayAndBaseDir(({ relayUrl, baseDir }) =>
      Effect.gen(function* () {
        const exit = yield* runCli([
          "relay",
          "connect",
          relayUrl,
          "--token",
          "wrong",
          "--base-dir",
          baseDir,
        ]).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(
          yield* Effect.promise(() => readRelayConfig(NodePath.join(baseDir, "userdata"))),
          null,
        );
      }),
    ),
  );

  it.effect("connect refuses a plain-HTTP relay on another machine", () =>
    Effect.gen(function* () {
      const exit = yield* runCli([
        "relay",
        "connect",
        "http://relay.example.com",
        "--token",
        "t",
      ]).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
