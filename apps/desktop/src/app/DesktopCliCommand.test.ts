import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentFor = (
  path: Path.Path,
  input: { home: string; baseDir: string; platform?: NodeJS.Platform; isPackaged?: boolean },
) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform ?? "linux",
    isPackaged: input.isPackaged ?? true,
    homeDirectory: input.home,
    baseDir: input.baseDir,
    stateDir: path.join(input.baseDir, "userdata"),
    desktopSettingsPath: path.join(input.baseDir, "userdata", "desktop-settings.json"),
    serverRoot: "/opt/AgentD Next/resources/app.asar",
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const commandIn = (
  input: {
    home: string;
    baseDir?: string;
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    env?: NodeJS.ProcessEnv;
  },
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = input.baseDir ?? path.join(input.home, ".agentd-desktop");
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const make = DesktopCliCommand.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        environmentFor(path, { ...input, baseDir }),
      ),
      Effect.provideService(HostProcess.Environment, input.env ?? { PATH: "", SHELL: "/bin/zsh" }),
    );
    return yield* spawner
      ? make.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      : make;
  });

/** `inherited` stands in for the app's own environment, which `extendEnv` passes on. */
const fakePowerShell = (initial: string, inherited: Record<string, string> = {}) => {
  const registry = { path: initial, failReads: false, writes: 0 };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { options } = command as unknown as {
        readonly options: { readonly env?: Record<string, string>; readonly extendEnv?: boolean };
      };
      const env = { ...(options.extendEnv ? inherited : {}), ...options.env };
      let exitCode = 0;
      let stdout = "";
      if (env.T3_SET === "1") {
        registry.path = env.T3_PATH ?? "";
        registry.writes += 1;
      } else if (registry.failReads) {
        exitCode = 1;
      } else {
        stdout = Buffer.from(registry.path, "utf8").toString("base64");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { registry, spawner };
};

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home, env });
      const link = path.join(home, ".local", "bin", "libraos-next");

      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        onPath: false,
        launcherPath: null,
      });
      yield* command.installOnFirstLaunch;
      expect((yield* command.state).installedPath).toBe(link);
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(installed.launcherPath).toBe(
        path.join(home, ".agentd-desktop", "bin", "libraos-next"),
      );
      expect(installed.pathSetup).toEqual({ file: "~/.zshrc", added: false });
      expect(yield* fs.readLink(link)).toBe(
        path.join(home, ".agentd-desktop", "bin", "libraos-next"),
      );
      expect((yield* command.install).installedPath).toBe(link);
      // The `agentd-next` and `t3` aliases are the same launcher under the earlier names.
      const alias = path.join(home, ".local", "bin", "t3");
      const earlierAlias = path.join(home, ".local", "bin", "agentd-next");
      for (const each of [alias, earlierAlias]) {
        expect(yield* fs.readLink(each)).toBe(
          path.join(home, ".agentd-desktop", "bin", "libraos-next"),
        );
      }

      // Add to PATH appends one line, once, and keeps a final line with no newline intact.
      const zshrc = path.join(home, ".zshrc");
      yield* fs.writeFileString(zshrc, "# mine");
      // A folder already on PATH needs nothing.
      env.PATH = path.join(home, ".local", "bin");
      yield* command.addToPath;
      expect(yield* fs.readFileString(zshrc)).toBe("# mine");
      env.PATH = "";
      yield* Effect.all([command.addToPath, command.addToPath], { concurrency: "unbounded" });
      expect((yield* command.addToPath).pathSetup).toEqual({ file: "~/.zshrc", added: true });
      expect(yield* fs.readFileString(zshrc)).toBe(
        '# mine\n# Added by LibraOS Next\nexport PATH="$PATH:$HOME/.local/bin"\n',
      );

      expect((yield* command.uninstall).installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);
      expect(yield* fs.exists(alias)).toBe(false);
      expect(yield* fs.exists(earlierAlias)).toBe(false);
      expect(yield* fs.exists(path.join(home, ".agentd-desktop", "bin", "libraos-next"))).toBe(
        true,
      );
      // Removed stays removed: first launch never installs again.
      yield* command.installOnFirstLaunch;
      expect(yield* fs.exists(link)).toBe(false);

      // Also when first launch was put off (no shell PATH yet) and the user removed it meanwhile.
      const laterHome = yield* fs.makeTempDirectoryScoped();
      const later = yield* commandIn({ home: laterHome, env });
      yield* later.install;
      yield* later.uninstall;
      yield* later.installOnFirstLaunch;
      expect(yield* fs.exists(path.join(laterHome, ".local", "bin", "libraos-next"))).toBe(false);

      // An app that ran before left its settings or launcher. Its user may have removed t3 or
      // chosen another, so first launch leaves it to Settings, where Install still works.
      for (const left of ["userdata/desktop-settings.json", "bin/libraos-next"]) {
        const upgradedHome = yield* fs.makeTempDirectoryScoped();
        const leftFile = path.join(upgradedHome, ".agentd-desktop", left);
        yield* fs.makeDirectory(path.dirname(leftFile), { recursive: true });
        yield* fs.writeFileString(leftFile, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\n`);
        const upgraded = yield* commandIn({ home: upgradedHome, env });
        yield* upgraded.installOnFirstLaunch;
        const upgradedLink = path.join(upgradedHome, ".local", "bin", "libraos-next");
        expect(yield* fs.exists(upgradedLink)).toBe(false);
        expect((yield* upgraded.install).installedPath).toBe(upgradedLink);
      }
    }),
  );

  it.effect("keeps a legacy agentd-desktop command running this app until Remove", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const legacyLauncher = path.join(home, ".agentd-desktop", "bin", "agentd-desktop");
      const legacyLink = path.join(home, ".local", "bin", "agentd-desktop");
      yield* fs.makeDirectory(path.dirname(legacyLauncher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(legacyLink), { recursive: true });
      yield* fs.writeFileString(legacyLauncher, "#!/bin/sh\n# Written by AgentD Desktop: runs\n");
      yield* fs.symlink(legacyLauncher, legacyLink);
      const command = yield* commandIn({ home });

      yield* command.install;
      expect(yield* fs.readFileString(legacyLauncher)).toContain(DesktopCliShim.MARKER);
      expect(yield* fs.readLink(legacyLink)).toBe(legacyLauncher);

      yield* command.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      expect(Option.isNone(yield* fs.readLink(legacyLink).pipe(Effect.option))).toBe(true);
    }),
  );

  it.effect("never replaces or removes a t3 it did not create", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home, env });
      const theirs = path.join(home, ".local", "bin", "libraos-next");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's t3\n");
      yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "libraos-next"));

      yield* Effect.flip(command.install);
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
      expect(yield* fs.readLink(path.join(home, "bin", "libraos-next"))).toBe(
        path.join(home, "gone"),
      );

      // A fresh install beside someone else's t3 (even off PATH or a dangling link) adds no second
      // t3 in ~/bin.
      for (const dangling of [false, true]) {
        const besideHome = yield* fs.makeTempDirectoryScoped();
        const other = path.join(besideHome, ".local", "bin", "libraos-next");
        yield* fs.makeDirectory(path.dirname(other), { recursive: true });
        yield* dangling
          ? fs.symlink(path.join(besideHome, "gone"), other)
          : fs.writeFileString(other, "npm's t3\n");
        yield* (yield* commandIn({ home: besideHome })).installOnFirstLaunch;
        expect(yield* fs.exists(path.join(besideHome, "bin", "libraos-next"))).toBe(false);
      }

      const launcher = path.join(home, ".agentd-desktop", "bin", "libraos-next");
      yield* fs.writeFileString(launcher, "npm's t3\n");
      env.PATH = path.dirname(launcher);
      expect(yield* command.state).toMatchObject({ onPath: false, shadowedBy: launcher });
      expect((yield* Effect.flip(command.install)).message).toContain("Could not set up");
      yield* command.uninstall;
      expect(yield* fs.readFileString(launcher)).toBe("npm's t3\n");
    }),
  );

  it.effect.each(["t3", "agentd-next"])(
    "leaves a %s it did not create when installing and removing",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const theirs = path.join(home, ".local", "bin", name);
        const theirLink = path.join(home, "bin", name);
        yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
        yield* fs.makeDirectory(path.dirname(theirLink), { recursive: true });
        yield* fs.writeFileString(theirs, "npm's t3\n");
        yield* fs.symlink(theirs, theirLink);
        const command = yield* commandIn({ home });

        const installed = yield* command.install;
        expect(installed.installedPath).toBe(path.join(home, ".local", "bin", "libraos-next"));
        expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
        yield* command.uninstall;
        expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
        expect(yield* fs.readLink(theirLink)).toBe(theirs);
      }),
  );

  it.effect("keeps an earlier agentd-next command running this app and moves it on Install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const baseDir = path.join(home, ".agentd-desktop");
      const earlierLauncher = path.join(baseDir, "bin", "agentd-next");
      const earlierLink = path.join(home, ".local", "bin", "agentd-next");
      const earlierT3 = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(earlierLauncher), { recursive: true });
      yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.dirname(earlierLink), { recursive: true });
      yield* fs.writeFileString(
        earlierLauncher,
        "#!/bin/sh\n# Written by AgentD Next: runs the desktop app's bundled agentd-next CLI.\n",
      );
      yield* fs.symlink(earlierLauncher, earlierLink);
      yield* fs.symlink(earlierLauncher, earlierT3);
      yield* fs.writeFileString(path.join(baseDir, "userdata", "desktop-settings.json"), "{}");
      const command = yield* commandIn({ home });

      // An app update adds no command behind the user's back; the earlier one keeps working.
      yield* command.installOnFirstLaunch;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      expect(yield* fs.readLink(earlierLink)).toBe(earlierLauncher);

      const installed = yield* command.install;
      const launcher = path.join(baseDir, "bin", "libraos-next");
      expect(installed.installedPath).toBe(path.join(home, ".local", "bin", "libraos-next"));
      expect(yield* fs.readFileString(earlierLauncher)).toContain(DesktopCliShim.MARKER);
      // Every name runs the same launcher, with the same T3 home baked in.
      for (const name of ["libraos-next", "lnext", "agentd-next", "t3"]) {
        const each = path.join(home, ".local", "bin", name);
        expect(yield* fs.readLink(each)).toBe(launcher);
        expect(yield* fs.realPath(each)).toBe(yield* fs.realPath(launcher));
      }
      expect(yield* fs.readFileString(launcher)).toContain(baseDir);

      yield* command.uninstall;
      for (const name of ["libraos-next", "lnext", "agentd-next", "t3"]) {
        const each = path.join(home, ".local", "bin", name);
        expect(Option.isNone(yield* fs.readLink(each).pipe(Effect.option))).toBe(true);
      }
    }),
  );

  it.effect("adds lnext on a later launch beside a command installed before it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home, env: { PATH: "", SHELL: "/bin/zsh" } });
      yield* command.installOnFirstLaunch;
      const short = path.join(home, ".local", "bin", "lnext");
      yield* fs.remove(short);

      yield* command.installOnFirstLaunch;
      expect(yield* fs.readLink(short)).toBe(
        path.join(home, ".agentd-desktop", "bin", "libraos-next"),
      );
    }),
  );

  it.effect("finds and removes a link left by a previous T3 home", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const before = yield* commandIn({ home, baseDir: path.join(home, "old-t3"), env });
      const link = (yield* before.install).installedPath;

      const after = yield* commandIn({ home, baseDir: path.join(home, "new-t3"), env });
      // A first launch leaves another home's command alone; only Install takes it over.
      yield* after.installOnFirstLaunch;
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "old-t3", "bin", "libraos-next"));
      // On PATH, it runs the other home's launcher. Settings offers Install (not Remove, and not
      // "another t3 runs first"), which updates that link in place.
      env.PATH = path.dirname(link!);
      expect(yield* after.state).toMatchObject({ installedPath: null, onPath: false });
      expect((yield* after.state).shadowedBy).toBeUndefined();
      env.PATH = "";
      // Off PATH, Add to PATH would expose the other home's command, not this one.
      expect((yield* after.state).pathSetup).toBeUndefined();
      yield* Effect.flip(after.addToPath);
      expect(yield* fs.exists(path.join(home, ".zshrc"))).toBe(false);
      // Behind another t3 the install fails, and the old link still works.
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "libraos-next"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      env.PATH = shadow;
      yield* Effect.flip(after.install);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "old-t3", "bin", "libraos-next"));
      // Install takes it over, also with its folder first on PATH.
      env.PATH = path.dirname(link!);
      expect((yield* after.install).installedPath).toBe(link);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-t3", "bin", "libraos-next"));
      env.PATH = "";
      yield* after.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "bin", "libraos-next"))).toBe(false);

      // A folder already on PATH wins, even written with a trailing slash.
      env.PATH = `${path.join(home, "bin")}/`;
      expect((yield* after.install).installedPath).toBe(path.join(home, "bin", "libraos-next"));

      // An old link of ours is updated where it is, not moved to a folder that may be off PATH.
      yield* fs.writeFileString(path.join(home, "bin", "libraos-next.staging"), "mine");
      yield* fs.remove(path.join(home, "bin", "libraos-next"));
      yield* fs.symlink(
        path.join(home, "old-t3", "bin", "libraos-next"),
        path.join(home, "bin", "libraos-next"),
      );
      env.PATH = "";
      expect((yield* after.install).installedPath).toBe(path.join(home, "bin", "libraos-next"));
      expect(yield* fs.readLink(path.join(home, "bin", "libraos-next"))).toBe(
        path.join(home, "new-t3", "bin", "libraos-next"),
      );
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      expect(yield* fs.readFileString(path.join(home, "bin", "libraos-next.staging"))).toBe("mine");
    }),
  );

  it.effect("refuses to install behind another t3 that runs first", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "libraos-next"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      env.PATH = [shadow, `${path.join(home, ".local", "bin")}/`].join(":");

      const command = yield* commandIn({ home, env });
      const theirs = path.join(shadow, "libraos-next");
      expect((yield* command.state).shadowedBy).toBe(theirs);
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain(theirs);
      yield* command.installOnFirstLaunch;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      expect(yield* fs.readFileString(theirs)).toBe("#!/bin/sh\n");

      // Its folder is already on PATH behind theirs; adding it again would change which t3 runs.
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.symlink(
        path.join(home, ".agentd-desktop", "bin", "libraos-next"),
        path.join(home, ".local", "bin", "libraos-next"),
      );
      const behind = yield* command.state;
      expect(behind.installedPath).toBe(path.join(home, ".local", "bin", "libraos-next"));
      expect(behind.pathSetup).toBeUndefined();
      // Off PATH behind theirs, adding the folder would still put ours first.
      env.PATH = shadow;
      expect((yield* command.state).pathSetup).toBeUndefined();
      yield* Effect.flip(command.addToPath);
      expect(yield* fs.exists(path.join(home, ".zshrc"))).toBe(false);
      env.PATH = [shadow, `${path.join(home, ".local", "bin")}/`].join(":");
      yield* fs.remove(path.join(home, ".local", "bin", "libraos-next"));

      // A first-launch install that failed is not retried behind the user's back.
      yield* fs.remove(theirs);
      yield* command.installOnFirstLaunch;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "libraos-next"))).toBe(false);
      const installed = yield* command.install;
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "libraos-next"),
      });
      expect(installed.shadowedBy).toBeUndefined();
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "skips a t3 directory or a file this user cannot execute",
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const folder = path.join(home, "folder");
        const plain = path.join(home, "plain");
        const shadow = path.join(home, "shadow");
        yield* fs.makeDirectory(path.join(folder, "libraos-next"), { recursive: true });
        yield* fs.makeDirectory(plain);
        yield* fs.writeFileString(path.join(plain, "libraos-next"), "notes\n");
        // Root can execute mode 0o601; other users must honor the owner permissions.
        yield* fs.chmod(path.join(plain, "libraos-next"), process.getuid?.() === 0 ? 0o600 : 0o601);
        yield* fs.makeDirectory(shadow);
        yield* fs.writeFileString(path.join(shadow, "libraos-next"), "#!/bin/sh\n", {
          mode: 0o755,
        });
        env.PATH = [folder, plain, shadow, path.join(home, ".local", "bin")].join(":");

        const command = yield* commandIn({ home, env });
        expect((yield* command.state).shadowedBy).toBe(path.join(shadow, "libraos-next"));

        const error = yield* Effect.flip(command.install);
        expect(error.message).toContain(path.join(shadow, "libraos-next"));

        yield* fs.remove(shadow, { recursive: true });
        expect(yield* command.install).toMatchObject({
          onPath: true,
          installedPath: path.join(home, ".local", "bin", "libraos-next"),
        });
      }),
  );

  it.effect("does not treat its own launcher as another t3 when its folder is first on PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "", SHELL: "/bin/zsh" };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcher = path.join(home, ".agentd-desktop", "bin", "libraos-next");
      env.PATH = [path.dirname(launcher), path.join(home, ".local", "bin")].join(":");

      const command = yield* commandIn({ home, env });
      const installed = yield* command.install;

      expect(yield* fs.exists(launcher)).toBe(true);
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "libraos-next"),
      });
      expect(installed.shadowedBy).toBeUndefined();
      expect(yield* command.state).toEqual(installed);

      const removed = yield* command.uninstall;
      expect(removed.installedPath).toBeNull();
      expect(removed.onPath).toBe(true);
      expect(yield* command.state).toEqual(removed);
      expect(yield* fs.exists(installed.installedPath!)).toBe(false);
      expect(yield* fs.exists(launcher)).toBe(true);
    }),
  );

  it.effect("leaves the Windows PATH alone when it cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm;%USERPROFILE%\\tools";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      registry.failReads = true;
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("left unchanged");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });

      registry.failReads = false;
      const launcherDir = DesktopCliShim.launcherPath(
        environmentFor(yield* Path.Path, {
          home,
          baseDir: `${home}/.agentd-desktop`,
          platform: "win32",
        }),
      ).replace(/[\\/]libraos-next\.cmd$/, "");
      yield* command.install;
      expect(registry.path).toBe(`${userPath};${launcherDir}`);
      const separator = launcherDir.includes("\\") ? "\\" : "/";
      const windowsAliases = ["lnext.cmd", "t3.cmd", "agentd-next.cmd"].map(
        (name) => `${launcherDir}${separator}${name}`,
      );
      for (const windowsAlias of windowsAliases) {
        expect(yield* fs.readFileString(windowsAlias)).toContain(DesktopCliShim.MARKER);
      }
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
      for (const windowsAlias of windowsAliases) {
        expect(yield* fs.exists(windowsAlias)).toBe(false);
      }

      // A `;` in the folder would split it into two PATH entries, so nothing is written.
      const split = fakePowerShell(userPath);
      const semicolon = yield* commandIn(
        { home, baseDir: `${home}\\T3;Home`, platform: "win32" },
        split.spawner,
      );
      expect((yield* Effect.flip(semicolon.install)).message).toContain('has a ";"');
      expect(split.registry).toMatchObject({ path: userPath, writes: 0 });

      // An inherited T3_SET=1 never turns a read into a write of the whole PATH.
      const inherited = fakePowerShell(userPath, { T3_SET: "1", T3_PATH: "C:\\other" });
      const reader = yield* commandIn({ home, platform: "win32" }, inherited.spawner);
      yield* reader.install;
      expect(inherited.registry).toMatchObject({ path: `${userPath};${launcherDir}`, writes: 1 });
    }),
  );

  it.effect("does not claim or remove a Windows PATH entry the user added", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcherDir = path.dirname(
        DesktopCliShim.launcherPath(
          environmentFor(path, {
            home,
            baseDir: path.join(home, ".agentd-desktop"),
            platform: "win32",
          }),
        ),
      );
      const userPath = `C:\\Tools;${launcherDir}`;
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);

      // A fresh install beside another libraos-next.cmd, even off PATH, leaves
      // PATH alone.
      const besideHome = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(besideHome, ".local", "bin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(besideHome, ".local", "bin", "libraos-next.cmd"),
        "@echo off\r\n",
      );
      const beside = fakePowerShell("C:\\Tools");
      yield* (yield* commandIn({ home: besideHome, platform: "win32" }, beside.spawner))
        .installOnFirstLaunch;
      expect(beside.registry).toMatchObject({ path: "C:\\Tools", writes: 0 });
    }),
  );
});
