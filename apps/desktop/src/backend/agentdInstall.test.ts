import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AgentdInstallRecord } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  decideAgentdInstall,
  installAgentdAfterConsent,
  installRecordPath,
  servicesRefreshAgentd,
  withWindowsPathEntry,
} from "./agentdInstall.ts";

describe("decideAgentdInstall", () => {
  it.each([
    [
      { existing: false, sameBytes: false, installedVersion: null, bundledVersion: null },
      "installed",
    ],
    [
      { existing: true, sameBytes: true, installedVersion: null, bundledVersion: null },
      "unchanged",
    ],
    [
      { existing: true, sameBytes: false, installedVersion: "v0.1.9", bundledVersion: "v0.1.11" },
      "replaced",
    ],
    [
      { existing: true, sameBytes: false, installedVersion: "v0.2.0", bundledVersion: "v0.1.11" },
      "kept-newer",
    ],
    [
      {
        existing: true,
        sameBytes: false,
        installedVersion: "v0.1.11",
        bundledVersion: "v0.1.11-rc.1",
      },
      "kept-newer",
    ],
    [
      { existing: true, sameBytes: false, installedVersion: null, bundledVersion: "v0.1.11" },
      "kept-unknown",
    ],
  ] as const)("%o is %s", (input, action) => {
    expect(decideAgentdInstall(input)).toBe(action);
  });
});

describe("withWindowsPathEntry", () => {
  const dir = "C:\\Users\\les\\AppData\\Local\\Programs\\agentd";
  it("appends the folder once, keeping every other entry as written", () => {
    expect(withWindowsPathEntry("%USERPROFILE%\\bin;;C:\\tools", dir)).toBe(
      `%USERPROFILE%\\bin;;C:\\tools;${dir}`,
    );
    expect(withWindowsPathEntry("", dir)).toBe(dir);
    expect(withWindowsPathEntry("C:\\tools;", dir)).toBe(`C:\\tools;${dir}`);
    expect(withWindowsPathEntry(`C:\\tools;${dir.toUpperCase()}\\`, dir)).toBeNull();
  });
});

const task = (command: string, agentd: string, root: string, service = "watchdog") =>
  `<Actions Context="Author"><Exec><Command>${command}</Command><Arguments>&quot;${agentd}&quot; service-run --env &quot;${root}\\services\\agentd-${service}.env&quot; --log x.log -- ${service}</Arguments></Exec></Actions>`;

describe("servicesRefreshAgentd", () => {
  const ours = "C:\\Users\\me\\AppData\\Local\\Programs\\agentd\\agentd.exe";
  const root = "C:\\Users\\me\\.local\\share\\agentd";
  const launcher = `${root}\\services\\agentd-service.exe`;
  it("refreshes only tasks that all run this app's agentd, directly or through the launcher", () => {
    expect(servicesRefreshAgentd([task(launcher, ours, root), null], [ours])).toBe(ours);
    // Paths compare as Windows does: without case.
    expect(servicesRefreshAgentd([null, task(ours.toUpperCase(), "x", root)], [ours])).toBe(
      ours.toUpperCase(),
    );
    expect(servicesRefreshAgentd([null, null], [ours])).toBeNull();
    // install rewrites both tasks: one on the user's own agentd, or one unread, stops it.
    expect(
      servicesRefreshAgentd(
        [task(launcher, ours, root), task(launcher, "C:\\tools\\agentd.exe", root, "dash")],
        [ours],
      ),
    ).toBeNull();
    expect(servicesRefreshAgentd([task(launcher, ours, root), undefined], [ours])).toBeNull();
  });
});

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(AgentdInstallRecord));

/** A Windows machine as the install pass sees it, with a fake spawner and a real temp folder. */
const windowsPass = (input: {
  readonly installed: string | null;
  readonly installedVersion?: string;
  /** A libraos-engine already beside it; it answers `version` with installedVersion too. */
  readonly engineInstalled?: string;
  readonly platform?: NodeJS.Platform;
  readonly taskAgentd?: (target: string) => string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const home = path.join(base, "home");
    const resources = path.join(base, "resources");
    const windows = (input.platform ?? "win32") === "win32";
    const exe = windows ? "agentd.exe" : "agentd";
    const bundled = path.join(resources, "agentd", exe);
    const directory = windows
      ? path.join(home, "Local", "Programs", "agentd")
      : path.join(home, ".local", "bin");
    const target = path.join(directory, exe);
    const engine = path.join(directory, windows ? "libraos-engine.exe" : "libraos-engine");
    const root = path.join(home, ".local", "share", "agentd");
    yield* fs.makeDirectory(path.dirname(bundled), { recursive: true });
    yield* fs.writeFileString(bundled, "agentd v0.1.23 with the signed launcher");
    yield* fs.writeFileString(path.join(resources, "agentd", "SKILL.md"), "skill");
    yield* fs.writeFileString(path.join(resources, "agentd", "SKILL-agentd.md"), "skill");
    if (input.installed !== null) {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(target, input.installed);
    }
    if (input.engineInstalled !== undefined) {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(engine, input.engineInstalled);
    }
    // The tasks agentd init registered for this root, through the launcher an older Engine wrote.
    yield* fs.makeDirectory(path.join(root, "services"), { recursive: true });
    const launcher = path.join(root, "services", "agentd-service.exe");
    yield* fs.writeFileString(launcher, "unsigned launcher of 2026-11-19");

    const calls: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const { command: program, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        calls.push([program, ...args]);
        let stdout = "";
        let exitCode = 0;
        if (args[0] === "version")
          stdout =
            program === bundled ? "agentd v0.1.23 x\n" : `agentd ${input.installedVersion} x\n`;
        else if (program === "schtasks") {
          const service = /agentd-(watchdog|dash)$/.exec(args[2] ?? "")?.[1];
          if (args[1] === "/TN" && service !== undefined) {
            const runs = input.taskAgentd?.(target) ?? target;
            // schtasks answers in UTF-16 with a byte order mark.
            stdout = `\uFEFF${task(launcher, runs, root, service)}`;
          } else exitCode = 1;
        }
        const bytes =
          program === "schtasks"
            ? Buffer.from(stdout, "utf16le")
            : new TextEncoder().encode(stdout);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(bytes),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const environment = DesktopEnvironment.DesktopEnvironment.of({
      path,
      platform: input.platform ?? "win32",
      isDevelopment: false,
      isPackaged: true,
      resourcesPath: resources,
      stateDir: path.join(base, "userdata"),
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
    yield* installAgentdAfterConsent().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(HostProcess.Environment, {
        USERPROFILE: home,
        HOME: home,
        LOCALAPPDATA: path.join(home, "Local"),
        PATH: "",
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const record = yield* decodeRecord(yield* fs.readFileString(installRecordPath(environment)));
    const installs = calls.filter((call) => call[1] === "install");
    const readEngine = fs.readFileString(engine).pipe(Effect.orElseSucceed(() => null));
    return { record, installs, target, calls, engine: yield* readEngine };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("installAgentdAfterConsent libraos-engine", (it) => {
  const BUNDLED = "agentd v0.1.23 with the signed launcher";
  it.effect("on Windows the engine is installed as libraos-engine.exe beside agentd.exe", () =>
    Effect.gen(function* () {
      const first = yield* windowsPass({ installed: null });
      expect(first.record.action).toBe("installed");
      expect(first.engine).toBe(BUNDLED);
      const upgrade = yield* windowsPass({
        installed: "agentd v0.1.20",
        installedVersion: "v0.1.20",
        engineInstalled: "agentd v0.1.20",
      });
      expect(upgrade.record.action).toBe("replaced");
      expect(upgrade.engine).toBe(BUNDLED);
      const again = yield* windowsPass({ installed: BUNDLED, engineInstalled: BUNDLED });
      expect(again.record.action).toBe("unchanged");
      expect(again.engine).toBe(BUNDLED);
      // Added under the old app's agentd.exe that is already the same.
      const added = yield* windowsPass({ installed: BUNDLED });
      expect(added.engine).toBe(BUNDLED);
    }),
  );

  it.effect("a folder holding the user's own agentd gets no libraos-engine from the app", () =>
    Effect.gen(function* () {
      const newer = yield* windowsPass({ installed: "agentd v0.2.0", installedVersion: "v0.2.0" });
      expect(newer.record.action).toBe("kept-newer");
      expect(newer.engine).toBeNull();
      const theirs = yield* windowsPass({
        installed: BUNDLED,
        engineInstalled: "libraos-engine v0.3.0",
        installedVersion: "v0.3.0",
      });
      expect(theirs.engine).toBe("libraos-engine v0.3.0");
    }),
  );

  it.effect("macOS and Linux install only agentd, as before", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "darwin"] as const) {
        const pass = yield* windowsPass({ installed: null, platform });
        expect(pass.record.action).toBe("installed");
        expect(pass.engine).toBeNull();
      }
    }),
  );
});

it.layer(NodeServices.layer)("installAgentdAfterConsent services refresh", (it) => {
  it.effect("an Engine upgrade on Windows runs the new agentd's install once", () =>
    Effect.gen(function* () {
      const { record, installs, target } = yield* windowsPass({
        installed: "agentd v0.1.20",
        installedVersion: "v0.1.20",
      });
      expect(record.action).toBe("replaced");
      expect(installs).toEqual([[target, "install"]]);
      expect(record.services).toEqual({ agentd: target, ok: true });
    }),
  );

  it.effect("a first install refreshes tasks already on this app's agentd", () =>
    Effect.gen(function* () {
      const { record, installs, target } = yield* windowsPass({ installed: null });
      expect(record.action).toBe("installed");
      expect(installs).toEqual([[target, "install"]]);
    }),
  );

  it.effect("an unchanged or kept agentd, or tasks on the user's own agentd, run no install", () =>
    Effect.gen(function* () {
      const unchanged = yield* windowsPass({
        installed: "agentd v0.1.23 with the signed launcher",
      });
      expect(unchanged.record.action).toBe("unchanged");
      const newer = yield* windowsPass({ installed: "agentd v0.2.0", installedVersion: "v0.2.0" });
      expect(newer.record.action).toBe("kept-newer");
      const unknown = yield* windowsPass({ installed: "agentd ?", installedVersion: "dev" });
      expect(unknown.record.action).toBe("kept-unknown");
      const chosen = yield* windowsPass({
        installed: "agentd v0.1.20",
        installedVersion: "v0.1.20",
        taskAgentd: () => "C:\\tools\\agentd.exe",
      });
      expect(chosen.record.action).toBe("replaced");
      for (const pass of [unchanged, newer, unknown, chosen]) {
        expect(pass.installs).toEqual([]);
        expect(pass.record.services).toBeUndefined();
      }
      // Only the tasks were read for the user's own agentd.
      expect(chosen.calls.some((call) => call[0] === "schtasks")).toBe(true);
    }),
  );

  it.effect("macOS and Linux run no install and query no tasks", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "darwin"] as const) {
        const pass = yield* windowsPass({
          installed: "agentd v0.1.20",
          installedVersion: "v0.1.20",
          platform,
        });
        expect(pass.record.action).toBe("replaced");
        expect(pass.installs).toEqual([]);
        expect(pass.calls.some((call) => call[0] === "schtasks")).toBe(false);
      }
    }),
  );
});
