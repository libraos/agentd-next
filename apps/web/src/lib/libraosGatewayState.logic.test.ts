import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isLibraosGatewayUsable, libraosGatewayAgentsChecked } from "./libraosGatewayState.logic";

describe("isLibraosGatewayUsable", () => {
  it("is usable only while connected and not refused", () => {
    expect(isLibraosGatewayUsable({ connected: true, refusal: null })).toBe(true);
    expect(isLibraosGatewayUsable({ connected: true })).toBe(true);
    expect(isLibraosGatewayUsable({ connected: true, refusal: "This API key is revoked." })).toBe(
      false,
    );
    expect(isLibraosGatewayUsable({ connected: false, refusal: null })).toBe(false);
    expect(isLibraosGatewayUsable(null)).toBe(false);
  });
});

describe("libraosGatewayAgentsChecked", () => {
  it("changes only when a Gateway agent is probed again", () => {
    const providers = (codexAt: string, gatewayAt: string) => [
      { instanceId: ProviderInstanceId.make("codex"), checkedAt: codexAt },
      { instanceId: ProviderInstanceId.make("libraosCodex"), checkedAt: gatewayAt },
    ];
    const before = libraosGatewayAgentsChecked(providers("t1", "t1"));
    expect(libraosGatewayAgentsChecked(providers("t2", "t1"))).toBe(before);
    expect(libraosGatewayAgentsChecked(providers("t2", "t2"))).not.toBe(before);
    expect(libraosGatewayAgentsChecked(null)).toBe("");
  });
});
