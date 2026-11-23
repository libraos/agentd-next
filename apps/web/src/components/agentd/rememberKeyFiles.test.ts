import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { beforeEach, expect, it, vi } from "vite-plus/test";

// What storage holds, as each window reads it; another window's write lands here first.
const storage = vi.hoisted(() => ({ settings: null as ClientSettings | null }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: { getClientSettings: async () => storage.settings } }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "~/hooks/useSettings";
import { persistRememberedKeyFiles } from "./rememberKeyFiles";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  storage.settings = null;
});

it("keeps a key path another window remembered while this one was writing", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  let durable: ClientSettings = DEFAULT_CLIENT_SETTINGS;
  const persist = vi.fn(async (settings: ClientSettings) => {
    if (persist.mock.calls.length === 1) {
      // The other window's write lands, and reaches this one, before this write finishes.
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        agentdCloudKeyFiles: { other: { openai: "/b/openai.key" } },
      });
      return;
    }
    durable = settings;
  });

  using _now = vi.spyOn(Date, "now").mockReturnValue(5);
  await persistRememberedKeyFiles("here", { anthropicKeyFile: "/a/anthropic.key" }, persist);

  const both = {
    other: { openai: "/b/openai.key" },
    here: { anthropic: "/a/anthropic.key", anthropicSavedAt: 5 },
  };
  expect(durable.agentdCloudKeyFiles).toEqual(both);
  expect(getClientSettings().agentdCloudKeyFiles).toEqual(both);
});

it("keeps a key path another window saved before its change reached this one", async () => {
  // This window's snapshot predates the other window's write; storage already has it.
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    agentdCloudKeyFiles: { here: { openai: "/old/openai.key" } },
  });
  storage.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    agentdCloudKeyFiles: {
      here: { openai: "/new/openai.key", anthropic: "/b/anthropic.key" },
      other: { openai: "/b/openai.key" },
    },
  };
  let durable: ClientSettings = DEFAULT_CLIENT_SETTINGS;
  const persist = vi.fn(async (settings: ClientSettings) => {
    durable = settings;
    storage.settings = settings;
  });

  using _now = vi.spyOn(Date, "now").mockReturnValue(5);
  await persistRememberedKeyFiles("third", { anthropicKeyFile: "/c/anthropic.key" }, persist);
  // The same environment: only the submitted provider's path changes.
  await persistRememberedKeyFiles("here", { anthropicKeyFile: "/a/anthropic.key" }, persist);

  expect(durable.agentdCloudKeyFiles).toEqual({
    here: { openai: "/new/openai.key", anthropic: "/a/anthropic.key", anthropicSavedAt: 5 },
    other: { openai: "/b/openai.key" },
    third: { anthropic: "/c/anthropic.key", anthropicSavedAt: 5 },
  });
});

it("keeps both provider paths when two saves queue in one window", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  storage.settings = DEFAULT_CLIENT_SETTINGS;
  const persist = async (settings: ClientSettings) => {
    storage.settings = settings;
  };
  using _now = vi.spyOn(Date, "now").mockReturnValue(5);
  await Promise.all([
    persistRememberedKeyFiles("here", { openaiKeyFile: "/a/openai.key" }, persist),
    persistRememberedKeyFiles("here", { anthropicKeyFile: "/a/anthropic.key" }, persist),
  ]);
  expect(storage.settings.agentdCloudKeyFiles).toEqual({
    here: {
      openai: "/a/openai.key",
      openaiSavedAt: 5,
      anthropic: "/a/anthropic.key",
      anthropicSavedAt: 5,
    },
  });
});
