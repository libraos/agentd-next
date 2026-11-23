import type { AgentdBackupCreated } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vite-plus/test";

import {
  backupDue,
  backupFileTime,
  lastBackupTime,
  runBackup,
  type BackupFolder,
} from "./backupTransfer";

const OLD = "agentd-backup-20261101T080000Z-0123abcd.age";
const NEW = "agentd-backup-20261121T101530Z-89abcdef.age";
const RECIPIENT = "age1q4d33m3a9720za7jflgm5shgtud2f0tzu6rq6am5tl78x67g6vqs53vjz3";
const DAY = 24 * 60 * 60_000;

function memoryFolder(initial: Record<string, Uint8Array>, served: Uint8Array) {
  const files = new Map(Object.entries(initial));
  const downloads: Array<string> = [];
  const folder: BackupFolder = {
    list: async () => [...files.keys()],
    download: async (url, name) => {
      downloads.push(url);
      files.set(name, served);
    },
    measure: async (name) => {
      const bytes = files.get(name)!;
      return { bytes: bytes.length, sha256: bytesToHex(sha256(bytes)) };
    },
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (name) => void files.delete(name),
  };
  return { folder, files, downloads };
}

function made(
  bytes: Uint8Array,
  overrides: Partial<AgentdBackupCreated> = {},
): AgentdBackupCreated {
  return {
    fileName: NEW,
    bytes: bytes.length,
    sha256: bytesToHex(sha256(bytes)),
    created: "2026-11-21T10:15:30Z",
    relativeUrl: `/api/assets/signed-token/${NEW}`,
    expiresAt: "2026-11-21T11:15:30Z",
    ...overrides,
  } as AgentdBackupCreated;
}

describe("runBackup", () => {
  const payload = new TextEncoder().encode("age-encryption.org/v1 ...");

  it("asks for a backup to this device's key, checks it and keeps only the newest", async () => {
    const { folder, files, downloads } = memoryFolder(
      {
        [OLD]: new Uint8Array([1]),
        [`${OLD}.part`]: new Uint8Array([2]),
        "notes.txt": new Uint8Array(),
      },
      payload,
    );
    const asked: Array<string> = [];
    const saved = await runBackup({
      recipient: RECIPIENT,
      httpBaseUrl: "http://192.168.1.20:3773/",
      folder,
      signal: new AbortController().signal,
      createBackup: async (input) => {
        asked.push(input.recipient);
        return made(payload);
      },
    });
    expect(asked).toEqual([RECIPIENT]);
    expect(downloads).toEqual([`http://192.168.1.20:3773/api/assets/signed-token/${NEW}`]);
    expect(saved).toEqual({
      fileName: NEW,
      bytes: payload.length,
      created: "2026-11-21T10:15:30Z",
    });
    expect([...files.keys()].sort()).toEqual([NEW, "notes.txt"]);
    expect(files.get(NEW)).toEqual(payload);
  });

  it("keeps the last good backup when the download is not the one the computer made", async () => {
    for (const reported of [
      made(payload, { sha256: "0".repeat(64) }),
      made(payload, { bytes: payload.length + 1 }),
    ]) {
      const { folder, files } = memoryFolder({ [OLD]: new Uint8Array([1]) }, payload);
      await expect(
        runBackup({
          recipient: RECIPIENT,
          httpBaseUrl: "http://192.168.1.20:3773/",
          folder,
          signal: new AbortController().signal,
          createBackup: async () => reported,
        }),
      ).rejects.toMatchObject({ _tag: "BackupTransferError", reason: "mismatch" });
      expect([...files.keys()]).toEqual([OLD]);
    }
  });

  it("downloads nothing when the computer names a file outside its backups", async () => {
    const { folder, downloads } = memoryFolder({}, payload);
    await expect(
      runBackup({
        recipient: RECIPIENT,
        httpBaseUrl: "http://192.168.1.20:3773/",
        folder,
        signal: new AbortController().signal,
        createBackup: async () => made(payload, { fileName: "../ledger.db" as never }),
      }),
    ).rejects.toMatchObject({ reason: "link" });
    expect(downloads).toEqual([]);
  });

  it("reports a failed download as one, leaving the folder as it was", async () => {
    const { folder, files } = memoryFolder({ [OLD]: new Uint8Array([1]) }, payload);
    await expect(
      runBackup({
        recipient: RECIPIENT,
        httpBaseUrl: "http://192.168.1.20:3773/",
        folder: {
          ...folder,
          download: async () => {
            throw new Error("offline");
          },
        },
        signal: new AbortController().signal,
        createBackup: async () => made(payload),
      }),
    ).rejects.toMatchObject({ reason: "download" });
    expect([...files.keys()]).toEqual([OLD]);
  });
});

describe("backup schedule", () => {
  it("reads when a backup was made from its name", () => {
    expect(backupFileTime(NEW)).toBe(Date.UTC(2026, 10, 21, 10, 15, 30));
    expect(backupFileTime(`${NEW}.part`)).toBeNull();
    expect(lastBackupTime([OLD, "notes.txt", NEW])).toBe(Date.UTC(2026, 10, 21, 10, 15, 30));
    expect(lastBackupTime(["notes.txt"])).toBeNull();
  });

  it("is due with no backup, after the interval, or when the last one is dated far ahead", () => {
    const now = Date.UTC(2026, 10, 21);
    expect(backupDue(null, now, 7 * DAY)).toBe(true);
    expect(backupDue(now - 6 * DAY, now, 7 * DAY)).toBe(false);
    expect(backupDue(now - 7 * DAY, now, 7 * DAY)).toBe(true);
    expect(backupDue(now + DAY, now, 7 * DAY)).toBe(false);
    expect(backupDue(now + 8 * DAY, now, 7 * DAY)).toBe(true);
  });
});
