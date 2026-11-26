// agentd's Windows services are Task Scheduler tasks. These read their definitions as agentd writes
// them (internal/agentd/schtasks.go), for the desktop app's install pass and the server's check.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync digest names the Windows tasks.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- agentd cleans Windows roots as POSIX paths.
import * as NodePathPosix from "node:path/posix";

import * as Effect from "effect/Effect";

export type AgentdTaskService = "watchdog" | "dash";

/** The windowless launcher a task runs since Engine v0.1.22: ROOT\services\agentd-service.exe. */
const SERVICE_LAUNCHER = "agentd-service.exe";

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `schtasks /Query /XML` output as text: UTF-16 when it starts with a byte order mark or a NUL. */
export function schtasksText(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0);
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
}

function taskArguments(xml: string): string | null {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml.replaceAll("\0", ""))?.[1];
  return args === undefined ? null : unescapeXml(args);
}

/** The env file an agentd task runs with: its `service-run --env FILE`, ROOT\services\NAME.env. */
export function taskEnvFile(xml: string): string | null {
  const args = taskArguments(xml);
  if (args === null) return null;
  const match = /(?:^|\s)--env\s+(?:"([^"]*)"|(\S+))/.exec(args);
  return match?.[1] ?? match?.[2] ?? null;
}

/** The program of a scheduled task's first action, from `schtasks /Query /XML`. */
export function taskProgram(xml: string): string | null {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml.replaceAll("\0", ""))?.[1];
  return command === undefined ? null : unescapeXml(command.trim()).replace(/^"(.*)"$/, "$1");
}

/** A Windows path as agentd compares it (schtasksRootKey): cleaned, forward slashes, lower case. */
export function windowsPathKey(file: string): string {
  const cleaned = NodePathPosix.normalize(file.replaceAll("\\", "/"));
  return (cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned).toLowerCase();
}

/** The root a task serves: the folder above its env file's ROOT\services. */
function taskRoot(xml: string): string | null {
  const envFile = taskEnvFile(xml);
  return envFile === null
    ? null
    : NodePathPosix.dirname(NodePathPosix.dirname(envFile.replaceAll("\\", "/")));
}

/**
 * The launcher and the agentd a task runs through it, when its Command is ROOT\services\
 * agentd-service.exe of the root its env file is in; the agentd is the action's first argument.
 */
export function taskLauncher(xml: string): { launcher: string; agentd: string } | null {
  const launcher = taskProgram(xml);
  const envFile = taskEnvFile(xml);
  const args = taskArguments(xml);
  if (launcher === null || envFile === null || args === null) return null;
  const services = NodePathPosix.dirname(envFile.replaceAll("\\", "/"));
  if (windowsPathKey(launcher) !== windowsPathKey(`${services}/${SERVICE_LAUNCHER}`)) return null;
  const first = /^\s*(?:"([^"]+)"|(\S+))\s+service-run(?:\s|$)/.exec(args);
  const agentd = first?.[1] ?? first?.[2];
  return agentd === undefined ? null : { launcher, agentd };
}

/** The agentd a task runs: through this root's launcher, else its Command directly. */
export function taskAgentd(xml: string): string | null {
  return taskLauncher(xml)?.agentd ?? taskProgram(xml);
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

/** agentd's task names for a root (schtasksTaskName): plain for the default root. */
export function taskNames(
  service: AgentdTaskService,
  root: string | undefined,
): ReadonlyArray<string> {
  const plain = `\\LibraOS\\agentd-${service}`;
  if (root === undefined || root.trim() === "") return [plain];
  const hash = NodeCrypto.createHash("sha256")
    .update(windowsPathKey(root))
    .digest("hex")
    .slice(0, 8);
  return [`${plain}-${hash}`, plain];
}

/** The task definition one schtasks call read: its text, or that it failed. */
export interface TaskQuery {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * A root's task for a service: its definition, null when it has none, undefined when that can't
 * be told (a failed query for a task the listing names; schtasks' errors are localized). `listing`
 * keeps the one listing a check reads. The plain legacy name counts only for this root's env file.
 */
export const rootTaskDefinition = Effect.fn("agentdTasks.rootTaskDefinition")(function* <E, R>(
  service: AgentdTaskService,
  root: string | undefined,
  exec: (args: ReadonlyArray<string>) => Effect.Effect<TaskQuery, E, R>,
  listing: { current: string | null | undefined },
) {
  const names = taskNames(service, root);
  const legacy = names[1];
  for (const task of names) {
    const query = yield* exec(["/Query", "/TN", task, "/XML"]);
    if (!query.ok) {
      if (listing.current === undefined) {
        const all = yield* exec(["/Query", "/FO", "CSV", "/NH"]);
        listing.current = all.ok ? all.text : null;
      }
      if (listing.current !== null && !listsTask(listing.current, task)) continue;
      return undefined;
    }
    if (task === legacy) {
      const owner = taskRoot(query.text);
      if (owner === null || windowsPathKey(owner) !== windowsPathKey(root ?? "")) continue;
    }
    return query.text as string | null | undefined;
  }
  return null;
});

/**
 * Whether a launcher on disk is the one an agentd embeds: Windows releases carry it byte for byte
 * (go:embed), so an older or replaced launcher is not inside the agentd that should have written it.
 */
export function launcherEmbedded(launcher: Uint8Array, agentd: Uint8Array): boolean {
  return launcher.length > 0 && Buffer.from(agentd).includes(Buffer.from(launcher));
}
