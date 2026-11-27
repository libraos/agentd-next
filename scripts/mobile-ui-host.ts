// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - a CLI that owns a server subprocess.
/**
 * The computer the mobile UI tests pair with: a scratch server with no LibraOS Engine.
 *   start --bind <addr> [--device-host <host>] [--base-dir <dir>]: one JSON line, then serves
 *   revoke-all --base-dir <dir>
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

export interface HostLine {
  /** What a phone opens or scans to pair. */
  readonly pairingUrl: string;
  /** The server's origin as the phone reaches it. */
  readonly lanUrl: string;
  /** The Address and Code fields, for a build that does not take a pairing link. */
  readonly host: string;
  readonly code: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly baseDir: string;
}

export function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --flag value, got ${name ?? "nothing"}`);
    }
    flags.set(name.slice(2), value);
    index++;
  }
  return flags;
}

/** The address a phone uses: the bound one, or this machine's first LAN address for a wildcard. */
export function deviceHostFor(
  bind: string,
  interfaces: ReturnType<typeof NodeOS.networkInterfaces> = NodeOS.networkInterfaces(),
): string {
  if (bind !== "0.0.0.0" && bind !== "::") return bind;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function cli(baseDir: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync(
    "node",
    ["apps/server/src/bin.ts", ...args, "--base-dir", baseDir],
    { cwd: REPO_ROOT, encoding: "utf8", env: scratchEnv(baseDir) },
  );
  if (result.status !== 0) {
    throw new Error(
      `bin.ts ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

/** The last JSON value on stdout; the CLI may log lines before it. */
function lastJson(stdout: string): unknown {
  const start = Math.max(stdout.lastIndexOf("\n{"), stdout.lastIndexOf("\n["));
  return JSON.parse(stdout.slice(start + 1));
}

// A scratch HOME keeps the user's own config out, and a missing AGENTD_BIN leaves no Engine.
function scratchEnv(baseDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: NodePath.join(baseDir, "home"),
    AGENTD_BIN: NodePath.join(baseDir, "no-libraos-engine"),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The server never listened on ${port}.`);
}

// The descriptor answers before the server has named its environment.
async function readDescriptor(port: number): Promise<{ environmentId: string; label: string }> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
    const { environmentId, label } = (await response.json()) as {
      environmentId?: string;
      label?: string;
    };
    if (environmentId && label) return { environmentId, label };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The server never named its environment.");
}

async function start(flags: Map<string, string>): Promise<void> {
  const bind = flags.get("bind");
  if (!bind) throw new Error("start needs --bind <addr>");
  const deviceHost = flags.get("device-host") ?? deviceHostFor(bind);
  const baseDir = NodePath.resolve(
    flags.get("base-dir") ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-ui-host-")),
  );
  const workspace = NodePath.join(baseDir, "workspace");
  NodeFS.mkdirSync(NodePath.join(baseDir, "home"), { recursive: true });
  NodeFS.mkdirSync(workspace, { recursive: true });

  const port = await freePort();
  const lanUrl = `http://${deviceHost.includes(":") ? `[${deviceHost}]` : deviceHost}:${port}`;
  // Before the server starts: a CLI may not migrate a database a running server owns.
  const pairing = lastJson(
    cli(baseDir, ["auth", "pairing", "create", "--base-url", lanUrl, "--ttl", "1h", "--json"]),
  ) as { pairUrl: string; credential: string };
  const log = NodeFS.openSync(NodePath.join(baseDir, "server.log"), "a");
  const server = NodeChildProcess.spawn(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      bind,
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
      "--log-level",
      "warn",
      workspace,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", log, log], env: scratchEnv(baseDir) },
  );
  const stop = () => {
    server.kill("SIGTERM");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("exit", (code) => {
    process.stderr.write(`The server exited (${code}); see ${baseDir}/server.log\n`);
    process.exit(1);
  });

  await waitForPort(port);
  const descriptor = await readDescriptor(port);
  const line: HostLine = {
    pairingUrl: pairing.pairUrl,
    lanUrl,
    host: new URL(lanUrl).host,
    code: pairing.credential,
    environmentId: descriptor.environmentId,
    environmentName: descriptor.label,
    baseDir,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function revokeAll(flags: Map<string, string>): void {
  const baseDir = flags.get("base-dir");
  if (!baseDir) throw new Error("revoke-all needs --base-dir <dir>");
  const sessions = lastJson(cli(baseDir, ["auth", "session", "list", "--json"])) as Array<{
    sessionId: string;
  }>;
  for (const session of sessions) {
    cli(baseDir, ["auth", "session", "revoke", session.sessionId]);
  }
  process.stdout.write(`Revoked ${sessions.length} session(s).\n`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const flags = parseFlags(rest);
    if (command === "start") await start(flags);
    else if (command === "revoke-all") revokeAll(flags);
    else
      throw new Error("Usage: mobile-ui-host.ts start --bind <addr> | revoke-all --base-dir <dir>");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
