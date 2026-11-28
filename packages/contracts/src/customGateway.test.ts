import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  CustomGatewaySaveInput,
  CustomGatewaySetting,
  customGatewayAgentsOf,
  customGatewayIdOfInstance,
  defaultGatewayName,
  isGatewayInstanceId,
} from "./customGateway.ts";

const decodeGatewaySetting = Schema.decodeUnknownSync(CustomGatewaySetting);
const decodeGatewaySaveInput = Schema.decodeUnknownSync(CustomGatewaySaveInput);

describe("defaultGatewayName", () => {
  it("names a gateway with no name typed after its URL's host", () => {
    expect(defaultGatewayName("https://40.49.6.2:18643/v1")).toBe("40.49.6.2");
    expect(defaultGatewayName(" https://gateway.meganova.ai/v1/ ")).toBe("gateway.meganova.ai");
    expect(defaultGatewayName("http://[::1]:8080/v1")).toBe("::1");
    expect(defaultGatewayName("not a url")).toBe("not a url");
  });
});

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

  it("decodes saved gateways and offers agents for their format", () => {
    for (const format of ["openai", "anthropic", "both"]) {
      const setting = { id: "a1", name: "Work", url: "https://example.com/v1", format };
      expect(decodeGatewaySetting(setting)).toEqual(setting);
      const input = { url: setting.url, format, key: "key" };
      expect(decodeGatewaySaveInput(input)).toEqual(input);
    }
    expect(customGatewayAgentsOf("openai")).toEqual(["codex", "opencode", "pi"]);
    expect(customGatewayAgentsOf("anthropic")).toEqual(["claude", "opencode"]);
    expect(customGatewayAgentsOf("both")).toEqual(["claude", "codex", "opencode", "pi"]);
    expect(decodeGatewaySaveInput({ extendId: "a1" })).toEqual({ extendId: "a1" });
  });
});
