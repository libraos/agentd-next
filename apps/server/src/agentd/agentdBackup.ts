import * as DateTime from "effect/DateTime";

// Where agentd backups for a paired device wait to be downloaded: one directory of the server's
// own state, holding at most the newest backup, under the one file name pattern the asset route
// serves. The file is encrypted to the asking device's public key before it is written.

export const AGENTD_BACKUP_FILE = /^agentd-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.age$/;

export function agentdBackupsDir(
  path: { readonly join: (...parts: ReadonlyArray<string>) => string },
  stateDir: string,
): string {
  return path.join(stateDir, "agentd-backups");
}

/** A new backup's file name: when it was made, in UTC, and 32 random bits so two never clash. */
export function agentdBackupFileName(nowMs: number, random: Uint8Array): string {
  const stamp = DateTime.formatIso(DateTime.makeUnsafe(nowMs))
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const suffix = Array.from(random.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `agentd-backup-${stamp}-${suffix}.age`;
}
