import type { AgentdCloudTaskInput } from "@t3tools/contracts";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { rememberKeyFiles } from "./startTask.logic";

// This window's saves run one at a time, so each reads storage after the one before it wrote.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Keeps the BYOK paths a cloud worker took. Storage, read just before the write, is the base: this
 * window's snapshot may predate another window's save and would write its older paths back. Only
 * the submitted paths go on top; the storage write keeps paths another window saved meanwhile.
 */
export function persistRememberedKeyFiles(
  environmentId: string,
  submitted: Parameters<typeof rememberKeyFiles>[2],
  persist?: Parameters<typeof persistClientSettingsUpdate>[1],
) {
  const save = queue.then(async () => {
    const stored = await ensureLocalApi()
      .persistence.getClientSettings()
      .then((settings) => settings?.agentdCloudKeyFiles)
      .catch(() => undefined);
    return persistClientSettingsUpdate(
      (current) => ({
        ...current,
        agentdCloudKeyFiles: rememberKeyFiles(
          stored ?? current.agentdCloudKeyFiles,
          environmentId,
          submitted,
          Date.now(),
        ),
      }),
      persist,
    );
  });
  queue = save.catch(() => undefined);
  return save;
}

/** After a cloud worker took the task: the BYOK paths it was given prefill the next one. */
export function rememberCloudKeyFiles(
  environmentId: string,
  submitted: AgentdCloudTaskInput["cloud"],
) {
  if (submitted.modelAccess !== "byok") return;
  // A path not remembered is typed again next time; the task already started.
  void persistRememberedKeyFiles(environmentId, submitted).catch(() => undefined);
}
