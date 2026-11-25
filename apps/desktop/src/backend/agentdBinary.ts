import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export const AGENTD_BIN_ENV = "AGENTD_BIN";
/** Set beside AGENTD_BIN when the app carries agentd, so the server never sends anyone to install it. */
export const AGENTD_BUNDLED_ENV = "AGENTD_DESKTOP_BUNDLED";
const VERSION_TIMEOUT = Duration.seconds(5);
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const executableFile = (name: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? `${name}.exe` : name;

/** The name the terminal command is installed under; every Engine release answers to it. */
export const agentdBinaryName = (platform: NodeJS.Platform): string =>
  executableFile("agentd", platform);

/** LibraOS Engine's executable first, then its earlier names `libraos-core` and `agentd`. */
const coreBinaryNames = (platform: NodeJS.Platform): readonly string[] =>
  ["libraos-engine", "libraos-core", "agentd"].map((name) => executableFile(name, platform));

/** The version in `agentd version` output ("agentd v0.1.11 547cf3a6616b", "libraos-engine v…"), else null. */
export const parseAgentdVersion = (output: string): string | null => {
  const match =
    /^\s*(?:libraos-engine|libraos-core|agentd)\s+(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(
      output,
    );
  return match ? match[1]! : null;
};

const comparePrerelease = (a: string, b: string): number => {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xNumeric = /^\d+$/.test(x[i]!);
    const yNumeric = /^\d+$/.test(y[i]!);
    if (xNumeric && yNumeric && Number(x[i]) !== Number(y[i])) {
      return Number(x[i]) > Number(y[i]) ? 1 : -1;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1;
  }
  return Math.sign(x.length - y.length);
};

/** Semver order of two agentd versions; null when either is not a version. */
export const compareAgentdVersions = (a: string, b: string): number | null => {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1;
  }
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined || y[4] === undefined) return x[4] === undefined ? 1 : -1;
  return comparePrerelease(x[4], y[4]);
};

export interface AgentdCandidate {
  readonly path: string;
  readonly version: string | null;
}

/** The user's agentd wins only when its version is readable and newer than the bundled one. */
export const chooseAgentdBinary = (
  bundled: AgentdCandidate,
  user: AgentdCandidate | null,
): string => {
  if (user === null || user.version === null) return bundled.path;
  if (bundled.version === null) return user.path;
  return (compareAgentdVersions(user.version, bundled.version) ?? 0) > 0 ? user.path : bundled.path;
};

export const resolveBundledAgentdPath = Effect.fn("desktop.agentdBinary.resolveBundled")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = environment.isDevelopment
      ? []
      : coreBinaryNames(environment.platform).flatMap((name) => {
          const relative = environment.path.join("agentd", name);
          return environment.isPackaged
            ? [environment.path.join(environment.resourcesPath, relative)]
            : environment.resolveResourcePathCandidates(relative);
        });
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  },
);

/** The newest name anywhere on PATH wins over an earlier name in an earlier directory. */
export const findAgentdOnPath = Effect.fn("desktop.agentdBinary.findOnPath")(function* (
  env: NodeJS.ProcessEnv,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const windows = environment.platform === "win32";
  const pathKey = windows
    ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH")
    : "PATH";
  // A relative PATH entry would resolve against the app's working directory.
  const dirs = (env[pathKey] ?? "")
    .split(windows ? ";" : ":")
    .filter((dir) => environment.path.isAbsolute(dir));
  for (const name of coreBinaryNames(environment.platform)) {
    for (const dir of dirs) {
      const candidate = environment.path.join(dir, name);
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
  }
  return Option.none<string>();
});

export const readAgentdVersion = Effect.fn("desktop.agentdBinary.readVersion")(function* (
  binaryPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(binaryPath, ["version"], {
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          windowsHide: true,
        }),
      );
      return yield* Stream.mkString(Stream.decodeText(child.stdout));
    }),
  ).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT),
    Effect.map(Option.getOrElse(() => "")),
    Effect.orElseSucceed(() => ""),
  );
  return parseAgentdVersion(output);
});

/**
 * The agentd the backend should use, for AGENTD_BIN: the bundled one, or the user's
 * from PATH when that is newer. None keeps the environment as it was: no bundle
 * (a build without AGENTD_DIST_DIR, dev) or an AGENTD_BIN the user set.
 */
export const resolveAgentdBin = Effect.fn("desktop.agentdBinary.resolve")(function* () {
  const env = yield* HostProcess.Environment;
  if ((env[AGENTD_BIN_ENV] ?? "") !== "") return Option.none<string>();
  const bundledPath = yield* resolveBundledAgentdPath();
  if (Option.isNone(bundledPath)) return Option.none<string>();
  const userPath = yield* findAgentdOnPath(env);
  const [bundledVersion, userVersion] = yield* Effect.all(
    [
      readAgentdVersion(bundledPath.value),
      Option.match(userPath, {
        onNone: () => Effect.succeed(null),
        onSome: readAgentdVersion,
      }),
    ],
    { concurrency: 2 },
  );
  return Option.some(
    chooseAgentdBinary(
      { path: bundledPath.value, version: bundledVersion },
      Option.match(userPath, {
        onNone: () => null,
        onSome: (path) => ({ path, version: userVersion }),
      }),
    ),
  );
});
