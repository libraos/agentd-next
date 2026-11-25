// Installs the bundled agentd and its two Skills where agentd's install.sh / install.ps1 would, so
// a terminal and the person's agents get the same agentd the app uses. Runs only after consent (first
// run, see libraos/agentd-desktop#13, or Set up LibraOS Engine's Accept) and never without a bundle.
// No client config is changed.
import { AgentdInstallRecord } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { WINDOWS_USER_PATH_SCRIPT } from "../app/DesktopCliCommand.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as AgentdBinary from "./agentdBinary.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-agentd-install");

/** The backend reads the last install pass from this file for the AgentD page. */
export const AGENTD_INSTALL_RECORD_ENV = "AGENTD_DESKTOP_INSTALL_RECORD";
/** Beside a binary this app placed on Windows; the uninstaller removes only such a binary. */
const AGENTD_INSTALL_MARKER = "agentd-desktop-installed";
const SKILLS = [
  ["agentd-setup", "SKILL.md"],
  ["agentd", "SKILL-agentd.md"],
] as const;

export type AgentdInstallAction = AgentdInstallRecord["action"];
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(AgentdInstallRecord));

/** What to do with the agentd at the install location; one not known to be older is never replaced. */
export const decideAgentdInstall = (input: {
  readonly existing: boolean;
  readonly sameBytes: boolean;
  readonly installedVersion: string | null;
  readonly bundledVersion: string | null;
}): AgentdInstallAction => {
  if (!input.existing) return "installed";
  if (input.sameBytes) return "unchanged";
  if (input.installedVersion === null || input.bundledVersion === null) return "kept-unknown";
  const order = AgentdBinary.compareAgentdVersions(input.installedVersion, input.bundledVersion);
  if (order === null) return "kept-unknown";
  return order > 0 ? "kept-newer" : "replaced";
};

const sameDirectory = (a: string, b: string, windows: boolean) => {
  const trim = (value: string) => value.trim().replace(/[\\/]+$/, "");
  return windows ? trim(a).toLowerCase() === trim(b).toLowerCase() : trim(a) === trim(b);
};

/** The Windows user PATH with `directory` appended, or null when it is already there. */
export const withWindowsPathEntry = (value: string, directory: string): string | null => {
  if (value.split(";").some((entry) => sameDirectory(entry, directory, true))) return null;
  return value === "" || value.endsWith(";") ? `${value}${directory}` : `${value};${directory}`;
};

const envValue = (env: NodeJS.ProcessEnv, name: string, windows: boolean) => {
  if (!windows) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

export const installRecordPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(environment.stateDir, "agentd-install.json");

// Launch, first-run consent and Set up LibraOS Engine's Accept can overlap; passes share temp names.
const installPasses = Semaphore.makeUnsafe(1);

export const installAgentdAfterConsent = Effect.fn("desktop.agentdInstall.afterConsent")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = yield* HostProcess.Environment;
    const path = environment.path;
    const windows = environment.platform === "win32";

    const bundled = yield* AgentdBinary.resolveBundledAgentdPath();
    if (Option.isNone(bundled)) return;
    const bundleDirectory = path.dirname(bundled.value);
    const home = envValue(env, windows ? "USERPROFILE" : "HOME", windows);
    if (!home || !path.isAbsolute(home)) {
      return yield* logWarning("no home folder in the environment; agentd not installed");
    }
    const localAppData =
      envValue(env, "LOCALAPPDATA", windows) || path.join(home, "AppData", "Local");
    const directory = windows
      ? path.join(localAppData, "Programs", "agentd")
      : path.join(home, ".local", "bin");
    const target = path.join(directory, AgentdBinary.agentdBinaryName(environment.platform));
    const marker = path.join(directory, AGENTD_INSTALL_MARKER);
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    const isLink = (file: string) =>
      fs.readLink(file).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const sameBytes = (a: string, b: string) =>
      Effect.all([fs.readFile(a), fs.readFile(b)]).pipe(
        Effect.map(([x, y]) => Buffer.from(x).equals(Buffer.from(y))),
        Effect.orElseSucceed(() => false),
      );

    yield* fs.makeDirectory(directory, { recursive: true });
    const existing = yield* exists(target);
    const unchanged = existing && (yield* sameBytes(bundled.value, target));
    const [bundledVersion, installedVersion] =
      existing && !unchanged
        ? yield* Effect.all(
            [AgentdBinary.readAgentdVersion(bundled.value), AgentdBinary.readAgentdVersion(target)],
            { concurrency: 2 },
          )
        : [null, null];
    const action = decideAgentdInstall({
      existing,
      sameBytes: unchanged,
      installedVersion,
      bundledVersion,
    });
    const placed = action === "installed" || action === "replaced";
    const kept = action === "kept-newer" || action === "kept-unknown";

    if (placed) {
      // Copy beside it, then rename over it. Windows cannot replace a running agentd.exe but can
      // rename it, so the old one moves aside first and comes back if the last rename fails.
      const fresh = `${target}.new.${process.pid}`;
      const aside = `${target}.old`;
      yield* Effect.gen(function* () {
        yield* fs.copyFile(bundled.value, fresh);
        if (!windows) yield* fs.chmod(fresh, 0o755);
        const movedAside =
          windows && existing
            ? yield* fs
                .remove(aside, { force: true })
                .pipe(Effect.andThen(fs.rename(target, aside)), Effect.as(true))
            : false;
        yield* fs
          .rename(fresh, target)
          .pipe(
            Effect.tapError(() =>
              movedAside ? fs.rename(aside, target).pipe(Effect.ignore) : Effect.void,
            ),
          );
        // Still running from before: it stays as .old until the next pass.
        if (movedAside) yield* fs.remove(aside, { force: true }).pipe(Effect.ignore);
      }).pipe(Effect.ensuring(fs.remove(fresh, { force: true }).pipe(Effect.ignore)));
    }
    if (windows && placed) {
      yield* fs.writeFileString(marker, `${action}\n`);
    } else if (windows && kept) {
      yield* fs.remove(marker, { force: true }).pipe(Effect.ignore);
    }

    // Skills at install.sh's paths. Without a new binary only missing Skills are added, so a
    // person's edit is not undone at every launch; a differing one is kept beside the new one.
    const claudeHome = envValue(env, "CLAUDE_CONFIG_DIR", windows) || path.join(home, ".claude");
    const codexHome = envValue(env, "CODEX_HOME", windows) || path.join(home, ".codex");
    const configHome = envValue(env, "XDG_CONFIG_HOME", windows) || path.join(home, ".config");
    const agentsSkills = path.join(home, ".agents", "skills");
    const opencodeHome = path.join(configHome, "opencode");
    const stamp = DateTime.formatIso(yield* DateTime.now)
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15);
    const hasSkills = (skillsDirectory: string) =>
      Effect.forEach(SKILLS, ([name, file]) =>
        sameBytes(path.join(bundleDirectory, file), path.join(skillsDirectory, name, "SKILL.md")),
      ).pipe(Effect.map((same) => same.every(Boolean)));
    const skillsWritten: string[] = [];
    const placeSkills = Effect.fn("desktop.agentdInstall.placeSkills")(function* (
      skillsDirectory: string,
    ) {
      // A symlink in the way (often to dotfiles or a checkout) is never written through.
      if (yield* isLink(skillsDirectory)) return;
      for (const [name, file] of SKILLS) {
        const folder = path.join(skillsDirectory, name);
        const skill = path.join(folder, "SKILL.md");
        if ((yield* isLink(folder)) || (yield* isLink(skill))) continue;
        const there = yield* exists(skill);
        if (there && !placed) continue;
        const source = path.join(bundleDirectory, file);
        yield* fs.makeDirectory(folder, { recursive: true });
        if (there && !(yield* sameBytes(source, skill))) {
          yield* fs.copyFile(skill, `${skill}.agentd-backup-${stamp}-${process.pid}`);
        }
        yield* fs.copyFile(source, skill);
        skillsWritten.push(skill);
      }
    });
    const pathEntries = (envValue(env, "PATH", windows) ?? "").split(windows ? ";" : ":");
    const hasCommand = Effect.fn("desktop.agentdInstall.hasCommand")(function* (name: string) {
      const extensions = windows ? [".exe", ".cmd", ".bat", ""] : [""];
      for (const entry of pathEntries) {
        if (!path.isAbsolute(entry)) continue;
        for (const extension of extensions) {
          if (yield* exists(path.join(entry, name + extension))) return true;
        }
      }
      return false;
    });
    if ((yield* hasCommand("claude")) || (yield* exists(claudeHome))) {
      yield* placeSkills(path.join(claudeHome, "skills"));
    }
    if ((yield* hasCommand("codex")) || (yield* exists(codexHome))) {
      yield* placeSkills(agentsSkills);
    }
    // opencode also reads ~/.claude/skills and ~/.agents/skills; a third copy would list each twice.
    if ((yield* hasCommand("opencode")) || (yield* exists(opencodeHome))) {
      const covered =
        (yield* hasSkills(path.join(home, ".claude", "skills"))) ||
        (yield* hasSkills(agentsSkills));
      if (!covered) yield* placeSkills(path.join(opencodeHome, "skills"));
    }

    let onPath = pathEntries.some((entry) => sameDirectory(entry, directory, windows));
    if (windows && !kept) {
      const powershell = (overrides: Record<string, string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = envValue(env, "SYSTEMROOT", true) ?? envValue(env, "WINDIR", true);
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                root
                  ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
                  : "powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
                {
                  stdin: "ignore",
                  stderr: "ignore",
                  env: overrides,
                  extendEnv: true,
                  windowsHide: true,
                },
              ),
            );
            const [stdout, exitCode] = yield* Effect.all(
              [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
              { concurrency: "unbounded" },
            );
            if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
            return stdout;
          }),
        );
      // A failed read leaves PATH alone: writing then would replace it wholesale.
      onPath = yield* powershell({ T3_SET: "0" }).pipe(
        Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
        Effect.flatMap((current) => {
          const next = withWindowsPathEntry(current, directory);
          return next === null ? Effect.void : powershell({ T3_SET: "1", T3_PATH: next });
        }),
        Effect.as(true),
        Effect.catch((error) =>
          logWarning("could not add agentd to the user PATH", { error }).pipe(Effect.as(onPath)),
        ),
      );
    }

    const record: AgentdInstallRecord = {
      action,
      path: target,
      directory,
      onPath,
      pathLine: onPath || windows ? null : `export PATH="${directory}:$PATH"`,
      skills: skillsWritten,
    };
    yield* fs.makeDirectory(environment.stateDir, { recursive: true });
    yield* fs.writeFileString(installRecordPath(environment), `${yield* encodeRecord(record)}\n`);
    yield* logInfo("agentd install pass", record);
  },
  (effect) =>
    effect.pipe(Effect.catchCause((cause) => logWarning("could not install agentd", { cause }))),
  installPasses.withPermits(1),
);
