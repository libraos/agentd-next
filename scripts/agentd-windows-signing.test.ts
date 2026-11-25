// @effect-diagnostics nodeBuiltinImport:off - Runs the release workflow's PowerShell signature gate against fixture files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Patch 280 signs the Windows build; agentd/patches/280-windows-signing.md is the record.
const root = NodePath.resolve(import.meta.dirname, "..");
const gate = NodePath.join(root, "agentd/scripts/check-windows-signatures.ps1");
const SIGNER = 'CN="Nebula Nova, Inc."';
const NEBULA = 'CN="Nebula Nova, Inc.", O="Nebula Nova, Inc.", L=Dover, S=Delaware, C=US';
const hasPwsh =
  NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

interface Signature {
  readonly status: string;
  readonly subject?: string;
  readonly timestamped?: boolean;
}

// Get-AuthenticodeSignature exists only on Windows; a function of the same name takes precedence.
const harness = `
$global:sigs = $env:SIGS | ConvertFrom-Json -AsHashtable
function Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  $s = $global:sigs[[IO.Path]::GetFileName($LiteralPath)]
  if (-not $s) { $s = @{ status = 'NotSigned' } }
  [pscustomobject]@{
    Status = $s.status
    SignerCertificate = if ($s.subject) { [pscustomobject]@{ Subject = $s.subject } } else { $null }
    TimeStamperCertificate = if ($s.timestamped) { [pscustomobject]@{ Subject = 'CN=Time Stamping Authority' } } else { $null }
  }
}
& $env:GATE -Installer $env:INSTALLER -Signer $env:SIGNER -StageParent $env:STAGE_PARENT
exit $LASTEXITCODE
`;

const runGate = async (sigs: Record<string, Signature>, options: { stages?: number } = {}) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agentd-win-signing-"));
  try {
    const installer = NodePath.join(dir, "release", "LibraOS-Next-1.2.3-x64.exe");
    await NodeFSP.mkdir(NodePath.dirname(installer), { recursive: true });
    await NodeFSP.writeFile(installer, "");
    const stageParent = NodePath.join(dir, "tmp");
    await NodeFSP.mkdir(stageParent);
    for (let i = 0; i < (options.stages ?? 1); i++) {
      const unpacked = NodePath.join(
        stageParent,
        `t3code-desktop-win-stage-${i}/app/dist/win-unpacked`,
      );
      await NodeFSP.mkdir(NodePath.join(unpacked, "resources"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(unpacked, "LibraOS Next.exe"), "");
      await NodeFSP.writeFile(NodePath.join(unpacked, "resources", "addon.node"), "");
    }
    const result = NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-Command", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        SIGS: JSON.stringify(sigs),
        GATE: gate,
        INSTALLER: installer,
        SIGNER,
        STAGE_PARENT: stageParent,
      },
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};

const signed: Signature = { status: "Valid", subject: NEBULA, timestamped: true };

describe.skipIf(!hasPwsh)("Windows signature gate", () => {
  it("passes a valid, timestamped signature from the publisher on both binaries", async () => {
    const run = await runGate({ "LibraOS-Next-1.2.3-x64.exe": signed, "LibraOS Next.exe": signed });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain("::warning::1 binaries in win-unpacked are not signed");
  });

  it.each([
    ["no timestamp", { ...signed, timestamped: false }, "has no timestamp"],
    ["another publisher", { ...signed, subject: 'CN="Someone Else"' }, "is not validly signed"],
    ["no signature", { status: "NotSigned" }, "is not validly signed"],
  ])("fails an app executable with %s", async (_name, app, message) => {
    const run = await runGate({ "LibraOS-Next-1.2.3-x64.exe": signed, "LibraOS Next.exe": app });
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain(`LibraOS Next.exe ${message}`);
  });

  it("fails an installer without a timestamp", async () => {
    const run = await runGate({
      "LibraOS-Next-1.2.3-x64.exe": { ...signed, timestamped: false },
      "LibraOS Next.exe": signed,
    });
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain("LibraOS-Next-1.2.3-x64.exe has no timestamp");
  });

  it("fails when the unpacked app cannot be found", async () => {
    const sigs = { "LibraOS-Next-1.2.3-x64.exe": signed, "LibraOS Next.exe": signed };
    const run = await runGate(sigs, { stages: 0 });
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain("expected one kept build stage");
  });
});

describe("Windows release job", () => {
  const workflow = NodeFS.readFileSync(
    NodePath.join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const job = workflow.slice(
    workflow.indexOf("\n  build-windows:"),
    workflow.indexOf("\n  checksums:"),
  );
  const steps = job.split("\n      - ").slice(1);

  // The cached token lives at least 60 minutes and the Azure CLI stops handing it out 5 minutes
  // before it expires; signing runs at the end of the build step.
  it("signs within the life of the token cached just before the build", () => {
    const cache = steps.findIndex((step) =>
      step.startsWith("name: Cache an Artifact Signing token"),
    );
    const build = steps[cache + 1] ?? "";
    expect(build).toContain("T3CODE_DESKTOP_SIGNED");
    const timeout = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(build)?.[1]);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(50);
  });
});
