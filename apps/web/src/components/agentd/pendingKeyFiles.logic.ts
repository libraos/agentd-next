import { AgentdCloudTaskInput, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

const PendingKeyFiles = Schema.Struct({
  environmentId: EnvironmentId,
  taskId: Schema.String,
  submitted: AgentdCloudTaskInput.fields.cloud,
});
export type PendingKeyFiles = typeof PendingKeyFiles.Type;

const STORAGE_KEY = "agentd:pending-cloud-key-files";
const Stored = Schema.Array(PendingKeyFiles);
// Tasks that never show a start or an end (removed from the ledger) mustn't pile up.
const MAX_PENDING = 20;

/** The offers whose BYOK paths wait for a start, kept across reloads; none when storage fails. */
export function storedPendingKeyFiles(): ReadonlyArray<PendingKeyFiles> {
  try {
    return getLocalStorageItem(STORAGE_KEY, Stored) ?? [];
  } catch {
    return [];
  }
}

/** Applies `update` to what storage holds now, so another window's entries stay. */
export function storePendingKeyFiles(
  update: (stored: ReadonlyArray<PendingKeyFiles>) => ReadonlyArray<PendingKeyFiles>,
): ReadonlyArray<PendingKeyFiles> {
  const next = update(storedPendingKeyFiles()).slice(-MAX_PENDING);
  try {
    setLocalStorageItem(STORAGE_KEY, next, Stored);
  } catch {
    // Unsaved, it is followed until this page reloads.
  }
  return next;
}

export const samePending = (a: PendingKeyFiles, b: PendingKeyFiles) =>
  a.environmentId === b.environmentId && a.taskId === b.taskId;
