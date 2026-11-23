import { describe, expect, it } from "vite-plus/test";
import { SecretProviderId, type ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldSecret,
  nextProviderEnvironmentWithFieldValue,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("shows exactly the live list for an agent whose models come from the Gateway", () => {
    expect(
      deriveProviderModelsForDisplay({
        liveModels: [
          { slug: "gpt-7-nova", name: "GPT-7 Nova", isCustom: true, capabilities: null },
        ],
        customModels: [{ slug: "old-custom", name: "old-custom", capabilities: null }],
        gatewayListed: true,
      }).map((model) => model.slug),
    ).toEqual(["gpt-7-nova"]);
  });

  it("leaves out a saved model the Gateway sub-provider's key denies in a mixed account", () => {
    expect(
      deriveProviderModelsForDisplay({
        liveModels: [
          { slug: "openai/gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
          { slug: "libraos/openai/gpt-6-luna", name: "Luna", isCustom: true, capabilities: null },
        ],
        customModels: [
          { slug: "libraos/openai/gpt-6-astra", name: "Astra", capabilities: null },
          { slug: "libraos/openai/gpt-6-luna", name: "Luna", capabilities: null },
          { slug: "uni/x", name: "x", capabilities: null },
        ],
        liveAuth: { status: "authenticated", endpointProviders: ["libraos"] },
      }).map((model) => model.slug),
    ).toEqual(["openai/gpt-5.4", "libraos/openai/gpt-6-luna", "uni/x"]);
  });
});

describe("provider environment helpers", () => {
  const cursorApiKeyField = {
    name: "CURSOR_API_KEY",
    label: "Cursor API key",
    sensitive: true,
  };

  it("writes dedicated provider secrets as sensitive environment variables", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "EXTRA_FLAG", value: "1", sensitive: false }],
        cursorApiKeyField,
        "  cursor-key  ",
      ),
    ).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
    ]);
  });

  it("replaces redacted provider secrets without preserving redaction markers", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [
          {
            name: "CURSOR_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
        cursorApiKeyField,
        "new-key",
      ),
    ).toEqual([{ name: "CURSOR_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("points a stored provider secret at a secret provider and drops the stored value", () => {
    const secret = {
      provider: SecretProviderId.make("personal"),
      reference: "op://Private/Cursor/credential",
    };
    const stored = [{ name: "CURSOR_API_KEY", value: "", sensitive: true, valueRedacted: true }];
    const referenced = nextProviderEnvironmentWithFieldSecret(stored, cursorApiKeyField, secret);

    expect(referenced).toEqual([{ name: "CURSOR_API_KEY", value: secret, sensitive: true }]);
    expect(
      nextProviderEnvironmentWithFieldSecret(referenced, cursorApiKeyField, undefined),
    ).toEqual([]);
  });

  it("applies the secure field default when replacing an existing non-sensitive value", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: false }],
        {
          name: "OPENAI_API_KEY",
          label: "OpenAI API key",
        },
        "new-key",
      ),
    ).toEqual([{ name: "OPENAI_API_KEY", value: "new-key", sensitive: true }]);
  });
});
