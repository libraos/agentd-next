import { ProviderInstanceId, type LibraosGatewaySignIn } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLibraosGatewayUsable,
  libraosGatewayAgentsChecked,
  libraosSignInView,
} from "./libraosGatewayState.logic";

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

describe("libraosSignInView", () => {
  const code = (userCode: string, purpose: LibraosGatewaySignIn["purpose"] = "connect") => ({
    purpose,
    userCode,
    verificationUri: "https://console.libraos.com/device",
    verificationUriComplete: `https://console.libraos.com/device?code=${userCode}`,
    expiresAt: 0,
  });

  it("shows the page itself while nothing is signing in, and a revoke is the Gateway panel's", () => {
    expect(libraosSignInView({ phase: "idle", ended: null }, null)).toBeNull();
    expect(libraosSignInView({ phase: "idle", ended: null }, code("AB", "revoke"))).toBeNull();
  });

  it("follows the click from starting to the code, then to done or a failure", () => {
    expect(libraosSignInView({ phase: "starting", id: 1 }, null)).toEqual({ kind: "starting" });
    // The code comes with the click's answer, before the status lists it.
    expect(
      libraosSignInView({ phase: "waiting", id: 1, signIn: code("AB"), opened: true }, null),
    ).toEqual({ kind: "waiting", signIn: code("AB"), opened: true });
    expect(
      libraosSignInView(
        { phase: "failed", id: 1, error: "The sign-in code expired.", hadCode: true },
        null,
      ),
    ).toEqual({ kind: "failed", error: "The sign-in code expired.", hadCode: true });
    expect(libraosSignInView({ phase: "done", id: 1, ended: "AB" }, code("AB"))).toEqual({
      kind: "done",
    });
  });

  it("shows a sign-in the server is running after a reload, but not one this window saw end", () => {
    expect(libraosSignInView({ phase: "idle", ended: null }, code("AB"))).toEqual({
      kind: "waiting",
      signIn: code("AB"),
      opened: false,
    });
    expect(libraosSignInView({ phase: "idle", ended: "AB" }, code("AB"))).toBeNull();
    expect(libraosSignInView({ phase: "signedIn", ended: "AB" }, code("AB"))).toBeNull();
  });
});
