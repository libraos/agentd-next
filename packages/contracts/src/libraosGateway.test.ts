import { describe, expect, it } from "@effect/vitest";

import { libraosCreditsRefusal } from "./libraosGateway.ts";

const MESSAGE =
  "Your LibraOS credits have run out. Top up on the Credits page of the Console to continue.";
const BODY = JSON.stringify({ error: { type: "insufficient_credits", message: MESSAGE } });

describe("libraosCreditsRefusal", () => {
  it("finds the Gateway's 402 in the words each Gateway agent fails the turn with", () => {
    const failures = {
      libraosClaude: `API Error: 402 ${MESSAGE}`,
      libraosCodex: `unexpected status 402 Payment Required: ${BODY}, url: https://api.libraos.com/v1/responses`,
      libraosOpencode: MESSAGE,
      libraosPi: `402: {"type":"insufficient_credits","message":"${MESSAGE}"}`,
    };
    for (const [instanceId, error] of Object.entries(failures)) {
      expect(libraosCreditsRefusal(instanceId, error)).toBe("out-of-credits");
    }
  });

  it("tells a used-up Token Plan apart", () => {
    expect(
      libraosCreditsRefusal(
        "libraosPi",
        '429: {"type":"plan_limit_reached","message":"Your Token Plan is used up."}',
      ),
    ).toBe("plan-limit");
  });

  it("leaves every other error, and the same text from other agents, alone", () => {
    expect(libraosCreditsRefusal("libraosClaude", "Connection reset by peer")).toBeNull();
    expect(libraosCreditsRefusal("libraosCodex", "402 Payment Required")).toBeNull();
    expect(libraosCreditsRefusal("codex", BODY)).toBeNull();
    expect(libraosCreditsRefusal("gw-abc-claude", BODY)).toBeNull();
    expect(libraosCreditsRefusal(undefined, BODY)).toBeNull();
    expect(libraosCreditsRefusal("libraosPi", null)).toBeNull();
  });
});
