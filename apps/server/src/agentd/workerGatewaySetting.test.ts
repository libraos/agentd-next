import type { CustomGatewaySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workerGatewayChoice } from "./workerGatewaySetting.ts";

const gateway = (format: "openai" | "anthropic", hasKey = true): CustomGatewaySummary => ({
  id: "gw1",
  name: "Team GW",
  url: "https://gw.example/v1/",
  format,
  hasKey,
  modelCount: 1,
  models: ["m-large"],
  hiddenModels: [],
  agents: [],
});
const keyFile = (id: string) => `/secrets/${id}.bin`;
const pick = { id: "gw1", model: "m-large" };

describe("workerGatewayChoice", () => {
  it("gives Claude Code the gateway's origin and the others its /v1", () => {
    expect(
      workerGatewayChoice({ tool: "claude", gateway: pick }, [gateway("anthropic")], keyFile),
    ).toEqual({ url: "https://gw.example", keyFile: "/secrets/gw1.bin", model: "m-large" });
    expect(
      workerGatewayChoice({ tool: "codex", gateway: pick }, [gateway("openai", false)], keyFile),
    ).toEqual({ url: "https://gw.example/v1", keyFile: null, model: "m-large" });
  });

  it("refuses a gateway of the wrong format, a model it does not offer, and one that is gone", () => {
    const refused = (choice: object) => "refused" in choice;
    expect(
      refused(
        workerGatewayChoice({ tool: "codex", gateway: pick }, [gateway("anthropic")], keyFile),
      ),
    ).toBe(true);
    expect(
      refused(
        workerGatewayChoice(
          { tool: "codex", gateway: { id: "gw1", model: "other" } },
          [gateway("openai")],
          keyFile,
        ),
      ),
    ).toBe(true);
    expect(refused(workerGatewayChoice({ tool: "codex", gateway: pick }, [], keyFile))).toBe(true);
  });
});
