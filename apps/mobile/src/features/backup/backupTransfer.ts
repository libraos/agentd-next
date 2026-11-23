import type { AgentdBackupCreated, AgentdBackupCreateInput } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Bringing one computer's agentd backup onto this device: ask the computer to make a backup
 * encrypted to this device's public key, download it, and keep it only if its size and SHA-256 are
 * what the computer reported. Each computer has its own folder, which holds its newest backup.
 */

const BACKUP_DIRECTORY = "agentd-backups";
const PARTIAL_SUFFIX = ".part";
const READ_CHUNK_BYTES = 1024 * 1024;
const FILE_TIME = /^agentd-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.age$/;
const isBackupFileName = (name: string) => FILE_TIME.test(name);

export const DEFAULT_BACKUP_EVERY_MS = 7 * 24 * 60 * 60_000;

export class BackupTransferError extends Schema.TaggedError<BackupTransferError>()(
  "BackupTransferError",
  {
    reason: Schema.Literals(["link", "download", "mismatch", "store"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "link":
        return "The computer made the backup but its download link is not usable.";
      case "download":
        return "The backup could not be downloaded. Check the connection and try again.";
      case "mismatch":
        return "The downloaded backup is not the one the computer made, so it was not kept.";
      case "store":
        return "The backup could not be saved on this device.";
    }
  }
}

const isBackupTransferError = Schema.is(BackupTransferError);

/** One computer's backup folder on this device. Names are file names inside it. */
export interface BackupFolder {
  readonly list: () => Promise<ReadonlyArray<string>>;
  readonly download: (url: string, name: string, signal: AbortSignal) => Promise<void>;
  readonly measure: (name: string) => Promise<{ readonly bytes: number; readonly sha256: string }>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
}

export interface SavedBackup {
  readonly fileName: string;
  readonly bytes: number;
  readonly created: string;
}

/** When the backup in `fileName` was made, from the time the computer wrote into its name. */
export function backupFileTime(fileName: string): number | null {
  const match = FILE_TIME.exec(fileName);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = DateTime.make(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

/** The newest backup's time among a folder's names, or null when it holds none. */
export function lastBackupTime(names: ReadonlyArray<string>): number | null {
  let newest: number | null = null;
  for (const name of names) {
    const time = backupFileTime(name);
    if (time !== null && (newest === null || time > newest)) newest = time;
  }
  return newest;
}

/**
 * Whether a computer should be backed up now. A backup dated more than `everyMs` ahead of this
 * device's clock counts as due too, so a computer whose clock ran fast is not skipped forever.
 */
export function backupDue(lastMs: number | null, nowMs: number, everyMs: number): boolean {
  return lastMs === null || nowMs - lastMs >= everyMs || lastMs - nowMs > everyMs;
}

async function attempt<A>(reason: BackupTransferError["reason"], run: () => Promise<A>) {
  try {
    return await run();
  } catch (cause) {
    if (isBackupTransferError(cause)) throw cause;
    throw new BackupTransferError({ reason, cause });
  }
}

/**
 * Make a backup on the computer and keep it on this device. The older backup in the folder is
 * removed only after the new one is checked, so a failed run leaves the last good backup in place.
 */
export async function runBackup(input: {
  readonly recipient: string;
  readonly httpBaseUrl: string;
  readonly folder: BackupFolder;
  readonly signal: AbortSignal;
  readonly createBackup: (input: AgentdBackupCreateInput) => Promise<AgentdBackupCreated>;
}): Promise<SavedBackup> {
  const made = await input.createBackup({ recipient: input.recipient });
  if (!isBackupFileName(made.fileName)) throw new BackupTransferError({ reason: "link" });
  const url = resolveAssetUrl(input.httpBaseUrl, made.relativeUrl);
  if (url === null) throw new BackupTransferError({ reason: "link" });

  const partial = `${made.fileName}${PARTIAL_SUFFIX}`;
  const { folder } = input;
  await attempt("download", () => folder.download(url, partial, input.signal));
  try {
    const measured = await attempt("store", () => folder.measure(partial));
    if (measured.bytes !== made.bytes || measured.sha256 !== made.sha256.toLowerCase()) {
      throw new BackupTransferError({ reason: "mismatch" });
    }
    await attempt("store", () => folder.rename(partial, made.fileName));
  } catch (error) {
    await folder.remove(partial).catch(() => undefined);
    throw error;
  }

  const names = await folder.list().catch(() => []);
  for (const name of names) {
    if (name === made.fileName) continue;
    if (isBackupFileName(name) || name.endsWith(PARTIAL_SUFFIX)) {
      await folder.remove(name).catch(() => undefined);
    }
  }
  return { fileName: made.fileName, bytes: made.bytes, created: made.created };
}

/** The folder in this app's documents that holds `environmentId`'s backups. */
export async function deviceBackupFolder(environmentId: string): Promise<BackupFolder> {
  const { Directory, File, FileMode, Paths } = await import("expo-file-system");
  const directory = new Directory(
    Paths.document,
    BACKUP_DIRECTORY,
    encodeURIComponent(environmentId),
  );
  const file = (name: string) => new File(directory, name);
  return {
    list: async () => {
      if (!directory.exists) return [];
      return directory.list().flatMap((entry) => (entry instanceof File ? [entry.name] : []));
    },
    download: async (url, name, signal) => {
      directory.create({ idempotent: true, intermediates: true });
      await File.downloadFileAsync(url, file(name), { idempotent: true, signal });
    },
    measure: async (name) => {
      const handle = file(name).open(FileMode.ReadOnly);
      try {
        const hash = sha256.create();
        let bytes = 0;
        for (;;) {
          const chunk = await handle.readBytes(READ_CHUNK_BYTES);
          if (chunk.length === 0) break;
          hash.update(chunk);
          bytes += chunk.length;
        }
        return { bytes, sha256: bytesToHex(hash.digest()) };
      } finally {
        handle.close();
      }
    },
    rename: async (from, to) => {
      const target = file(to);
      if (target.exists) target.delete();
      file(from).move(target);
    },
    remove: async (name) => {
      const target = file(name);
      if (target.exists) target.delete();
    },
  };
}
