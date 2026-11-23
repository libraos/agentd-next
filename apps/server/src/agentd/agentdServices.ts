// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync digest names the Windows tasks.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- agentd cleans Windows roots as POSIX paths.
import * as NodePathPosix from "node:path/posix";

import type {
  AgentdInstallRecord,
  AgentdServiceName,
  AgentdServicesProblem,
  AgentdServicesRepairResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ProcessRunner } from "../processRunner.ts";

// A service whose agentd is missing or the old AgentD Desktop's is only reported. Repair, which the
// user confirms, re-registers it with the agentd this app carries: its own `install` (and `dash
// install` for a Linux dash). An AppImage's agentd is never registered: its mount goes with the app.

type ServiceName = AgentdServiceName;
const SERVICES: ReadonlyArray<ServiceName> = ["watchdog", "dash"];

/** The old AgentD Desktop's install folder on macOS, Windows or Linux; not AgentD Next's. */
const OLD_DESKTOP = /(?:^|[\\/])AgentD[ -]Desktop(?:\.app)?[\\/]/i;
/** An AppImage's mount, such as /tmp/.mount_AgentDXXXXXX/: removed when that app quits. */
const APPIMAGE_MOUNT = /^\/(?:[^/]+\/)*\.mount_[^/]+\//;

/** A service program that is missing or the old app's; one that exists is never the app's to move. */
export function isStaleProgram(program: string, exists: boolean, bundled: string): boolean {
  return program !== bundled && (!exists || OLD_DESKTOP.test(program));
}

/**
 * The agentd services may run: the bundled one, unless it is inside this AppImage's mount. Then
 * the copy the app installed for the terminal (the same agentd, kept after the app quits), else
 * null: nothing lasting to register.
 */
export function serviceAgentd(
  bundled: string,
  appDir: string | undefined,
  installed: AgentdInstallRecord | null,
): string | null {
  const mount = appDir?.trim().replace(/\/+$/, "");
  const inMount = (file: string) =>
    APPIMAGE_MOUNT.test(file) || (!!mount && file.startsWith(`${mount}/`));
  if (!inMount(bundled)) return bundled;
  const ours =
    installed !== null && ["installed", "replaced", "unchanged"].includes(installed.action);
  return ours && !inMount(installed.path) ? installed.path : null;
}

// agentd connects no client to an agentd whose path has a space or a quote.
const UNCONNECTABLE = /[\s"']/;

/**
 * The agentd `init` runs as, which is the one it connects clients to. The bundled one, unless its
 * path is one agentd refuses (macOS: `/Applications/AgentD Next.app/...`); then the copy the app
 * installed for the terminal, the same agentd.
 */
export function setupAgentd(bundled: string, installed: AgentdInstallRecord | null): string {
  if (!UNCONNECTABLE.test(bundled)) return bundled;
  const ours =
    installed !== null && ["installed", "replaced", "unchanged"].includes(installed.action);
  return ours && !UNCONNECTABLE.test(installed.path) ? installed.path : bundled;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type PlistValue = string | boolean | ReadonlyArray<PlistValue> | ReadonlyMap<string, PlistValue>;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  amp: "&",
};

/** XML character data with its entities read; null on one XML doesn't define. */
function xmlText(text: string): string | null {
  let bad = false;
  const decoded = text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g,
    (whole, name?: string) => {
      const hex = name?.startsWith("#x") ?? false;
      const point = name?.startsWith("#")
        ? Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
        : undefined;
      const text =
        name === undefined
          ? undefined
          : point === undefined
            ? XML_ENTITIES[name]
            : point > 0 && point <= 0x10ffff
              ? String.fromCodePoint(point)
              : undefined;
      if (text === undefined) bad = true;
      return text ?? whole;
    },
  );
  return bad ? null : decoded;
}

/**
 * An XML property list as launchd reads it: comments, the prolog and CDATA allowed, scalars as
 * text. Undefined for anything else (a binary plist, malformed XML), which names nothing it can tell.
 */
function parsePlist(xml: string): PlistValue | undefined {
  const tokens: Array<
    | { readonly kind: "open" | "close" | "empty"; readonly name: string }
    | { readonly kind: "text"; readonly text: string }
  > = [];
  const body = xml.replace(/^\uFEFF/, "");
  const pattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][\w.-]*)(?:\s[^<>]*?)?(\/?)>|([^<]+)|</g;
  for (const match of body.matchAll(pattern)) {
    const [whole, cdata, close, name, empty, text] = match;
    if (cdata !== undefined) tokens.push({ kind: "text", text: cdata });
    else if (name !== undefined)
      tokens.push({ kind: close ? "close" : empty ? "empty" : "open", name });
    else if (text !== undefined) {
      const decoded = xmlText(text);
      if (decoded === null) return undefined;
      tokens.push({ kind: "text", text: decoded });
    } else if (whole === "<") return undefined;
  }
  let at = 0;
  const skipSpace = () => {
    while (tokens[at]?.kind === "text" && /^\s*$/.test((tokens[at] as { text: string }).text)) at++;
  };
  const textUntil = (name: string): string | undefined => {
    let text = "";
    for (;;) {
      const token = tokens[at++];
      if (token === undefined) return undefined;
      if (token.kind === "text") text += token.text;
      else if (token.kind === "close" && token.name === name) return text;
      else return undefined;
    }
  };
  const value = (): PlistValue | undefined => {
    skipSpace();
    const token = tokens[at++];
    if (token === undefined || token.kind === "text" || token.kind === "close") return undefined;
    const { name } = token;
    if (name === "true" || name === "false") {
      if (token.kind === "open" && textUntil(name)?.trim() !== "") return undefined;
      return name === "true";
    }
    if (["string", "key", "date", "integer", "real", "data"].includes(name))
      return token.kind === "empty" ? "" : textUntil(name);
    if (name === "array") {
      const items: PlistValue[] = [];
      if (token.kind === "empty") return items;
      for (;;) {
        skipSpace();
        const next = tokens[at];
        if (next?.kind === "close" && next.name === "array") {
          at++;
          return items;
        }
        const item = value();
        if (item === undefined) return undefined;
        items.push(item);
      }
    }
    if (name === "dict") {
      const entries = new Map<string, PlistValue>();
      if (token.kind === "empty") return entries;
      for (;;) {
        skipSpace();
        const next = tokens[at];
        if (next?.kind === "close" && next.name === "dict") {
          at++;
          return entries;
        }
        if (next?.kind !== "open" || next.name !== "key") return undefined;
        at++;
        const key = textUntil("key");
        const item = key === undefined ? undefined : value();
        if (key === undefined || item === undefined) return undefined;
        entries.set(key, item);
      }
    }
    return undefined;
  };
  skipSpace();
  const root = tokens[at++];
  if (root?.kind !== "open" || root.name !== "plist") return undefined;
  const plist = value();
  skipSpace();
  const end = tokens[at++];
  if (end?.kind !== "close" || end.name !== "plist") return undefined;
  skipSpace();
  return at === tokens.length ? plist : undefined;
}

const isDict = (value: PlistValue | undefined): value is ReadonlyMap<string, PlistValue> =>
  value instanceof Map;

/** The env file an agentd task runs with: its `service-run --env FILE`, ROOT\services\NAME.env. */
export function taskEnvFile(xml: string): string | null {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml.replaceAll("\0", ""))?.[1];
  if (args === undefined) return null;
  const match = /(?:^|\s)--env\s+(?:"([^"]*)"|(\S+))/.exec(unescapeXml(args));
  return match?.[1] ?? match?.[2] ?? null;
}

/** The program a LaunchAgent runs: its Program, else its first ProgramArguments string. */
export function plistProgram(plist: string): string | null {
  const parsed = parsePlist(plist);
  if (!isDict(parsed)) return null;
  const program = parsed.get("Program");
  const args = parsed.get("ProgramArguments");
  const first = program ?? (Array.isArray(args) ? args[0] : undefined);
  return typeof first === "string" && first.trim() !== "" ? first.trim() : null;
}

/**
 * The program a systemd unit runs, with %h as the home folder: its first ExecStart after the last
 * empty `ExecStart=`, which clears the ones before (as a drop-in does to override the unit's).
 */
export function unitProgram(unit: string, home: string): string | null {
  let line: string | undefined;
  for (const [, value] of unit.matchAll(/^[ \t]*ExecStart[ \t]*=(.*)$/gm)) {
    const command = value!.trim();
    if (command === "") line = undefined;
    else line ??= command.replace(/^[-@:+!]+\s*/, "");
  }
  if (line === undefined) return null;
  const quoted = /^"([^"]+)"/.exec(line)?.[1];
  const program = quoted ?? line.split(/\s+/)[0] ?? "";
  return program === "" ? null : program.replaceAll("%h", home);
}

/**
 * The drop-in folders systemd reads for a unit, most specific first: its own, then one for each
 * dash-ended prefix of its name (agentd-.service.d), then the one for all units of its type.
 */
export function dropInDirs(unit: string): ReadonlyArray<string> {
  const dot = unit.lastIndexOf(".");
  const [name, type] = [unit.slice(0, dot), unit.slice(dot)];
  const dirs = [`${unit}.d`];
  for (let dash = name.lastIndexOf("-", name.length - 2); dash > 0;) {
    dirs.push(`${name.slice(0, dash + 1)}${type}.d`);
    dash = name.lastIndexOf("-", dash - 1);
  }
  return [...dirs, `${type.slice(1)}.d`];
}

/** `schtasks /Query /XML` output as text: UTF-16 when it starts with a byte order mark or a NUL. */
export function schtasksText(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0);
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
}

/** The program of a scheduled task's first action, from `schtasks /Query /XML`. */
export function taskProgram(xml: string): string | null {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml.replaceAll("\0", ""))?.[1];
  return command === undefined ? null : unescapeXml(command.trim()).replace(/^"(.*)"$/, "$1");
}

/** Whether a `schtasks /Query /FO CSV /NH` listing names the task (names compare without case). */
function listsTask(listing: string, task: string): boolean {
  const name = `"${task.toLowerCase()}"`;
  return listing
    .replaceAll("\0", "")
    .toLowerCase()
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith(name));
}

/** A Windows root as agentd's task names compare it (schtasksRootKey): cleaned, lower case. */
function windowsRootKey(root: string): string {
  const cleaned = NodePathPosix.normalize(root.replaceAll("\\", "/"));
  return (cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned).toLowerCase();
}

/** agentd's task names for a root (schtasksTaskName): plain for the default root. */
export function taskNames(service: ServiceName, root: string | undefined): ReadonlyArray<string> {
  const plain = `\\LibraOS\\agentd-${service}`;
  if (root === undefined || root.trim() === "") return [plain];
  const hash = NodeCrypto.createHash("sha256")
    .update(windowsRootKey(root))
    .digest("hex")
    .slice(0, 8);
  return [`${plain}-${hash}`, plain];
}

/**
 * The program systemd has loaded for a unit whose file changed since its last reload, from
 * `systemctl show -p NeedDaemonReload -p ExecStart`; null when it has none pending.
 */
function loadedProgram(show: string): string | null {
  if (!/^NeedDaemonReload=yes$/m.test(show)) return null;
  return /^ExecStart=\{ path=(.+?) ;/m.exec(show)?.[1] ?? null;
}

/** The units `agentd install` asks to enable, from its "then:" line. */
export function unitsToEnable(installOutput: string): ReadonlyArray<string> {
  const line = /^then:.*enable --now (.+)$/m.exec(installOutput)?.[1] ?? "";
  return line.split(/\s+/).filter((unit) => /^agentd-[\w-]+\.(?:service|timer)$/.test(unit));
}

/** agentd's pre-rename units (install.go legacyUnits): install enables nothing while one is. */
const LEGACY_UNITS = [
  "agentops-daily.service",
  "agentops-daily.timer",
  "agentops-notify.service",
  "agentops-watchdog.service",
  "agentops-watchdog.timer",
  "agentops-dash.service",
  "agentops-rt-ports.service",
];

/** The step `agentd install` asks for before it enables anything: disabling still-enabled legacy units. */
function legacyDisableCommand(installOutput: string): string | null {
  const units = /first: systemctl --user disable --now ([^,\n]+)/.exec(installOutput)?.[1] ?? "";
  const names = units.split(/\s+/).filter((unit) => /^[\w.@-]+\.(?:service|timer)$/.test(unit));
  return names.length === 0 ? null : `systemctl --user disable --now ${names.join(" ")}`;
}

interface ServiceDeps {
  readonly bundled: string;
  /** The agentd to register: bundled, or null when it can't outlast this app (an AppImage). */
  readonly target: string | null;
  readonly platform: string;
  readonly home: string;
  readonly root: string | undefined;
  readonly run: ProcessRunner["Service"]["run"];
}

const runner =
  (run: ProcessRunner["Service"]["run"]) => (command: string, args: ReadonlyArray<string>) => {
    // schtasks may answer in UTF-16, which can't be read back from the runner's UTF-8 text.
    const chunks: Uint8Array[] = [];
    const onStdoutChunk = (chunk: Uint8Array) => void chunks.push(chunk);
    return run({
      command,
      args,
      timeout: "2 minutes",
      maxOutputBytes: 256 * 1024,
      onStdoutChunk,
    }).pipe(
      Effect.map((output) => ({
        ok: output.code === 0,
        text:
          (chunks.length > 0 ? schtasksText(Buffer.concat(chunks)) : output.stdout) + output.stderr,
      })),
      Effect.orElseSucceed(() => ({ ok: false, text: "" })),
    );
  };

/**
 * agentd's services that run a missing agentd or the old app's, and what Repair would re-register;
 * null when none does. Only reads: service files, schtasks queries on Windows, and on Linux
 * whether systemd runs the watchdog timer.
 */
export const detectServices = Effect.fn("AgentdServices.detect")(function* (deps: ServiceDeps) {
  const { bundled, target, platform, home, root } = deps;
  const exec = runner(deps.run);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A service file that is there but can't be read is undefined: unread, never taken as absent.
  const readService = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | null | undefined => text),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.orElseSucceed(() => undefined),
    );
  const unitDir = path.join(home, ".config", "systemd", "user");
  const names = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  // A unit with its drop-ins, which systemd reads after it: the program it runs in effect.
  const unitText = Effect.fn("AgentdServices.unit")(function* (file: string) {
    const unit = yield* readService(path.join(unitDir, file));
    if (unit === null || unit === undefined) return unit;
    // A drop-in file name taken from the most specific folder that has it, read in name order.
    const dropIns = new Map<string, string>();
    for (const dir of dropInDirs(file).toReversed())
      for (const name of yield* names(path.join(unitDir, dir)))
        if (name.endsWith(".conf")) dropIns.set(name, path.join(unitDir, dir, name));
    let text = unit;
    for (const name of [...dropIns.keys()].toSorted()) {
      const conf = yield* readService(dropIns.get(name)!);
      if (conf === undefined) return undefined;
      if (conf !== null) text += `\n${conf}`;
    }
    return { unit, text };
  });
  // Every task Task Scheduler has, read once: a failed query is an absent task only when this
  // listing reads and doesn't name it (schtasks' own error text is in the system's language).
  let listing: string | null | undefined;
  const listed = Effect.fn("AgentdServices.listTasks")(function* (task: string) {
    if (listing === undefined) {
      const all = yield* exec("schtasks", ["/Query", "/FO", "CSV", "/NH"]);
      listing = all.ok ? all.text : null;
    }
    return listing === null ? undefined : listsTask(listing, task);
  });
  // Services whose program a drop-in sets: agentd install rewrites only the unit file itself.
  const overridden: ServiceName[] = [];
  const program = Effect.fn("AgentdServices.program")(function* (name: ServiceName) {
    if (platform === "darwin") {
      const plist = yield* readService(
        path.join(home, "Library", "LaunchAgents", `com.libraos.agentd.${name}.plist`),
      );
      // A LaunchAgent that is there but names no program this can read (a binary plist) is unread.
      return plist === null || plist === undefined ? plist : (plistProgram(plist) ?? undefined);
    }
    if (platform === "win32") {
      const names = taskNames(name, root);
      const legacy = names[1];
      for (const task of names) {
        const query = yield* exec("schtasks", ["/Query", "/TN", task, "/XML"]);
        if (!query.ok) {
          const there = yield* listed(task);
          if (there === false) continue;
          return undefined;
        }
        const envFile = taskEnvFile(query.text);
        // The plain legacy name may be another root's task: only one whose env file is this root's.
        const owner =
          envFile === null
            ? null
            : NodePathPosix.dirname(NodePathPosix.dirname(envFile.replaceAll("\\", "/")));
        if (
          task === legacy &&
          (owner === null || windowsRootKey(owner) !== windowsRootKey(root ?? ""))
        )
          continue;
        return taskProgram(query.text) ?? undefined;
      }
      return null;
    }
    const unit = yield* unitText(`agentd-${name}.service`);
    if (unit === null || unit === undefined) return unit;
    const runs = unitProgram(unit.text, home);
    if (runs !== null && runs !== unitProgram(unit.unit, home)) overridden.push(name);
    return runs;
  });

  const agentd = target ?? bundled;
  const services: Array<{ name: ServiceName; program: string }> = [];
  // Services on another working agentd, the user's own: never moved.
  const kept: ServiceName[] = [];
  const unread: ServiceName[] = [];
  let watchdogOnTarget = false;
  // A unit file already on this agentd that systemd hasn't reloaded (a failed daemon-reload)
  // still runs the program it loaded: that one is in effect. A manager that doesn't answer leaves
  // the file's.
  const loaded = Effect.fn("AgentdServices.loaded")(function* (name: ServiceName) {
    const shown = yield* exec("systemctl", [
      "--user",
      "show",
      "-p",
      "NeedDaemonReload",
      "-p",
      "ExecStart",
      `agentd-${name}.service`,
    ]);
    return shown.ok ? loadedProgram(shown.text) : null;
  });
  for (const name of SERVICES) {
    const file = yield* program(name);
    if (file === undefined) unread.push(name);
    if (file === null || file === undefined) continue;
    const runs = platform === "linux" && file === agentd ? ((yield* loaded(name)) ?? file) : file;
    const exists = yield* fs.exists(runs).pipe(Effect.orElseSucceed(() => false));
    if (isStaleProgram(runs, exists, agentd)) services.push({ name, program: runs });
    else if (runs !== agentd) kept.push(name);
    else if (name === "watchdog") watchdogOnTarget = true;
  }
  let command: string | null = null;
  let watchdogOff = false;
  if (platform === "linux" && watchdogOnTarget) {
    // A repair that stopped before systemd enabled the timer (agentd's legacy-unit step, or a
    // failed reload or enable) left the new unit written but nothing running it: still reported,
    // with that step or with Repair to enable it, until the timer is on.
    const enabled = new Set<string>();
    for (const wants of (yield* names(unitDir)).filter((name) => name.endsWith(".wants")))
      for (const name of yield* names(path.join(unitDir, wants))) enabled.add(name);
    const legacy: string[] = [];
    for (const unit of LEGACY_UNITS)
      if (
        enabled.has(unit) &&
        (yield* fs.exists(path.join(unitDir, unit)).pipe(Effect.orElseSucceed(() => false)))
      )
        legacy.push(unit);
    if (!enabled.has("agentd-watchdog.timer")) {
      // A timer never written (install wrote the service, then failed) is off just the same.
      if (legacy.length > 0) command = `systemctl --user disable --now ${legacy.join(" ")}`;
      else watchdogOff = true;
    } else {
      // enable --now links the timer before it starts it, so a failed start leaves it enabled
      // but stopped. A manager that doesn't answer prints no state: not taken as off.
      const state = yield* exec("systemctl", ["--user", "is-active", "agentd-watchdog.timer"]);
      watchdogOff = ["inactive", "failed"].includes(state.text.split("\n")[0]!.trim());
    }
  }
  if (services.length === 0 && command === null && !watchdogOff) return null;
  // install registers both services on macOS and Windows, absent ones included, so it would move
  // one kept on the user's agentd or one it couldn't read too: no Repair then, and the user
  // confirms both. On Linux each service is re-registered on its own, unless a drop-in sets it.
  const linux = platform !== "darwin" && platform !== "win32";
  const blocked = target === null || (!linux && (kept.length > 0 || unread.length > 0));
  const stuck = overridden.filter((name) => services.some((service) => service.name === name));
  const moves = blocked
    ? []
    : linux
      ? SERVICES.filter(
          (name) =>
            !stuck.includes(name) &&
            (services.some((service) => service.name === name) ||
              (name === "watchdog" && (command !== null || watchdogOff))),
        )
      : SERVICES;
  return {
    services,
    agentd: target,
    moves,
    // On Linux a kept service stops nothing: Repair re-registers only the stale one.
    ...(!linux && kept.length > 0 ? { kept } : {}),
    ...(!linux && unread.length > 0 ? { unread } : {}),
    ...(stuck.length > 0 ? { overridden: stuck } : {}),
    ...(command === null ? {} : { command }),
    ...(watchdogOff ? { watchdogOff } : {}),
  } satisfies AgentdServicesProblem;
});

/**
 * Re-registers what `problem` says Repair moves, with the target agentd's own install; run only
 * when the user confirms it. On Linux, install's own systemd steps follow it.
 */
export const repairServices = Effect.fn("AgentdServices.repair")(function* (
  deps: ServiceDeps,
  problem: AgentdServicesProblem,
) {
  const { target, platform } = deps;
  const exec = runner(deps.run);
  if (target === null || problem.moves.length === 0)
    return { ok: false } satisfies AgentdServicesRepairResult;
  if (platform === "darwin" || platform === "win32")
    return { ok: (yield* exec(target, ["install"])).ok } satisfies AgentdServicesRepairResult;
  let ok = true;
  let command: string | null = null;
  if (problem.moves.includes("watchdog")) {
    const installed = yield* exec(target, ["install"]);
    ok = installed.ok;
    if (ok) {
      ok = (yield* exec("systemctl", ["--user", "daemon-reload"])).ok;
      const units = unitsToEnable(installed.text);
      // No enable step: agentd withheld it (legacy units still enabled), so nothing runs yet.
      command = legacyDisableCommand(installed.text);
      if (units.length === 0) ok = false;
      else if (ok) ok = (yield* exec("systemctl", ["--user", "enable", "--now", ...units])).ok;
    }
  }
  if (problem.moves.includes("dash")) ok = (yield* exec(target, ["dash", "install"])).ok && ok;
  return { ok, ...(command === null ? {} : { command }) } satisfies AgentdServicesRepairResult;
});
