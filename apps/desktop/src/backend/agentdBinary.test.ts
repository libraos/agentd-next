import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  chooseAgentdBinary,
  parseAgentdVersion,
  resolveBundledAgentdPath,
} from "./agentdBinary.ts";

const BUNDLED = "/app/resources/agentd/agentd";
const USER = "/home/me/.local/bin/agentd";

describe("chooseAgentdBinary", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly bundled: string | null;
    readonly user: string | null | undefined;
    readonly expected: string;
  }> = [
    { name: "no agentd on PATH", bundled: "v0.1.12", user: undefined, expected: BUNDLED },
    { name: "user newer patch", bundled: "v0.1.12", user: "v0.1.13", expected: USER },
    { name: "user newer minor", bundled: "v0.1.12", user: "v0.2.0", expected: USER },
    { name: "numeric not lexical", bundled: "v0.9.0", user: "v0.10.0", expected: USER },
    { name: "same version keeps bundled", bundled: "v0.1.12", user: "v0.1.12", expected: BUNDLED },
    { name: "user older", bundled: "v0.1.12", user: "v0.1.11", expected: BUNDLED },
    {
      name: "user prerelease of bundled",
      bundled: "v0.1.12",
      user: "v0.1.12-rc.1",
      expected: BUNDLED,
    },
    {
      name: "user release of bundled rc",
      bundled: "v0.1.12-rc.1",
      user: "v0.1.12",
      expected: USER,
    },
    { name: "later rc", bundled: "v0.1.12-rc.2", user: "v0.1.12-rc.10", expected: USER },
    { name: "user version unreadable", bundled: "v0.1.12", user: null, expected: BUNDLED },
    { name: "bundled version unreadable", bundled: null, user: "v0.1.1", expected: USER },
  ];
  it.each(cases)("$name", ({ bundled, user, expected }) => {
    assert.equal(
      chooseAgentdBinary(
        { path: BUNDLED, version: bundled },
        user === undefined ? null : { path: USER, version: user },
      ),
      expected,
    );
  });
});

describe("parseAgentdVersion", () => {
  it("reads the version from `agentd version` output", () => {
    assert.equal(parseAgentdVersion("agentd v0.1.11 547cf3a6616b\n"), "v0.1.11");
    assert.equal(parseAgentdVersion("agentd v0.2.0-rc.1\n"), "v0.2.0-rc.1");
    assert.equal(parseAgentdVersion("libraos-core v0.3.0 0d0b360a58c0\n"), "v0.3.0");
    assert.equal(parseAgentdVersion("agentd dev\n"), null);
    assert.equal(parseAgentdVersion("something v1.0.0"), null);
  });
});

it.layer(NodeServices.layer)("resolveBundledAgentdPath", (it) => {
  it.effect.each([
    { bundled: ["libraos-core", "agentd"], expected: "libraos-core" },
    { bundled: ["agentd"], expected: "agentd" },
  ])("runs $expected when the app carries $bundled", ({ bundled, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped({ prefix: "libraos-core-bundle-" });
      yield* fs.makeDirectory(path.join(resourcesPath, "agentd"));
      for (const name of bundled) {
        yield* fs.writeFileString(path.join(resourcesPath, "agentd", name), "");
      }
      const resolved = yield* resolveBundledAgentdPath().pipe(
        Effect.provideService(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            isDevelopment: false,
            isPackaged: true,
            platform: "linux",
            path,
            resourcesPath,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
      );
      assert.deepStrictEqual(resolved, Option.some(path.join(resourcesPath, "agentd", expected)));
    }).pipe(Effect.scoped),
  );
});
