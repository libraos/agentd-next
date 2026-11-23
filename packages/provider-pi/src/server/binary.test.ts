import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BundledPiCli, findBundledPiCli, piCommandLine, resolvePiBinaryPath } from "./binary.ts";

const withPiOnPath = Effect.fnUntraced(function* (present: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  if (present) {
    // POSIX finds `pi`; Windows finds `pi.cmd` through PATHEXT.
    for (const name of ["pi", "pi.cmd"]) {
      yield* fs.writeFileString(path.join(dir, name), "#!/bin/sh\n");
      yield* fs.chmod(path.join(dir, name), 0o755);
    }
  }
  return { PATH: dir, PATHEXT: ".CMD;.EXE" } as NodeJS.ProcessEnv;
});

it.layer(NodeServices.layer)("resolvePiBinaryPath", (it) => {
  it.effect("a binary path the user set wins over everything", () =>
    Effect.gen(function* () {
      const env = yield* withPiOnPath(true);
      assert.strictEqual(yield* resolvePiBinaryPath("/opt/pi/bin/pi", env), "/opt/pi/bin/pi");
    }).pipe(Effect.scoped, Effect.provideService(BundledPiCli, Effect.succeed("/app/cli.js"))),
  );

  it.effect("the user's own pi on PATH wins over the shipped one", () =>
    Effect.gen(function* () {
      const env = yield* withPiOnPath(true);
      assert.strictEqual(yield* resolvePiBinaryPath("pi", env), "pi");
    }).pipe(Effect.scoped, Effect.provideService(BundledPiCli, Effect.succeed("/app/cli.js"))),
  );

  it.effect("with no pi on PATH and nothing set, the shipped Pi runs", () =>
    Effect.gen(function* () {
      const env = yield* withPiOnPath(false);
      assert.strictEqual(yield* resolvePiBinaryPath("pi", env), "/app/cli.js");
      assert.strictEqual(yield* resolvePiBinaryPath("", env), "/app/cli.js");
    }).pipe(Effect.scoped, Effect.provideService(BundledPiCli, Effect.succeed("/app/cli.js"))),
  );

  it.effect("a build without the shipped Pi keeps asking for pi", () =>
    Effect.gen(function* () {
      const env = yield* withPiOnPath(false);
      assert.strictEqual(yield* resolvePiBinaryPath("pi", env), "pi");
    }).pipe(Effect.scoped, Effect.provideService(BundledPiCli, Effect.succeed(null))),
  );

  it.effect("finds the pinned Pi 1.6.0 this package depends on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = yield* findBundledPiCli();
      assert.isNotNull(cli);
      const manifest = JSON.parse(
        yield* fs.readFileString(path.join(path.dirname(cli!), "..", "..", "package.json")),
      ) as { name: string; version: string };
      assert.deepStrictEqual(manifest, { ...manifest, name: "@earendil-works/pi-coding-agent" });
      assert.strictEqual(manifest.version, "1.6.0");
    }).pipe(Effect.scoped),
  );
});

it("piCommandLine runs a script on this runtime and a binary as is", () => {
  const env = { PATH: "/bin" };
  assert.deepStrictEqual(piCommandLine("pi", ["--version"], env), {
    command: "pi",
    args: ["--version"],
    env,
  });
  const script = piCommandLine("/app/cli.js", ["--mode", "rpc"], env);
  assert.strictEqual(script.command, process.execPath);
  assert.deepStrictEqual(script.args, ["/app/cli.js", "--mode", "rpc"]);
});
