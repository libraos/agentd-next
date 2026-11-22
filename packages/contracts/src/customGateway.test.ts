import { describe, expect, it } from "@effect/vitest";

import {
  customGatewayAgentsOf,
  customGatewayIdOfInstance,
  isGatewayInstanceId,
} from "./customGateway.ts";

describe("gateway instance ids", () => {
  it("recognizes every gateway agent, Pi included, and nothing else", () => {
    for (const id of ["libraosClaude", "libraosCodex", "libraosOpencode", "libraosPi"]) {
      expect(isGatewayInstanceId(id)).toBe(true);
    }
    for (const agent of ["claude", "codex", "opencode", "pi"]) {
      expect(customGatewayIdOfInstance(`gw-a1-${agent}`)).toBe("a1");
    }
    for (const id of ["pi", "codex", "gw-a1-cursor", "gw-A1-pi"]) {
      expect(isGatewayInstanceId(id)).toBe(false);
    }
  });

  it("offers Pi on OpenAI-format gateways only", () => {
    expect(customGatewayAgentsOf("openai")).toEqual(["codex", "opencode", "pi"]);
    expect(customGatewayAgentsOf("anthropic")).toEqual(["claude", "opencode"]);
  });
});
