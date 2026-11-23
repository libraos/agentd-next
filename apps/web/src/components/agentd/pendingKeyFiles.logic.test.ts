import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("keeps following a recorded BYOK offer's paths after the page reloads, until it settles", async () => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  const environmentId = EnvironmentId.make("env-1");
  const submitted = {
    budget: "$5",
    modelAccess: "byok",
    openaiKeyFile: "/home/me/later.key",
  } as const;
  const page = await import("./PendingCloudKeyFiles");
  page.followCloudKeyFiles(environmentId, "hof-789aaa", submitted);
  page.followCloudKeyFiles(environmentId, "hof-789aaa", submitted);
  // A task that isn't BYOK carries no paths to keep.
  page.followCloudKeyFiles(environmentId, "hof-000bbb", { budget: "$5", modelAccess: "libraos" });

  vi.resetModules();
  const reloaded = await import("./pendingKeyFiles.logic");
  expect(reloaded.storedPendingKeyFiles()).toEqual([
    { environmentId, taskId: "hof-789aaa", submitted },
  ]);
});
