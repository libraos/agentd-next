import {
  LIBRAOS_GATEWAY_INSTANCE_IDS,
  ProviderDriverKind,
  ProviderInstanceId,
  type LibraosGatewayCredits,
  type LibraosGatewayPlans,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  libraosBalance,
  libraosConnection,
  libraosPlan,
  libraosPlansList,
  libraosReadyAgents,
} from "./libraosAccount.logic";

const reading = { data: null, error: null, isSuccess: false } as const;
const failed = { data: null, error: "The environment request failed.", isSuccess: false } as const;
const read = <A>(data: A) => ({ data, error: null, isSuccess: true });

const status = (connected: boolean, refusal: string | null = null) => read({ connected, refusal });

const credits = (overrides: Partial<LibraosGatewayCredits> = {}): LibraosGatewayCredits => ({
  availableUsd: 12.34,
  heldUsd: 0,
  enforced: true,
  amountsUsd: [10, 20],
  creditsUrl: "https://console.libraos.com/credits",
  plan: null,
  ...overrides,
});

const plans = (overrides: Partial<LibraosGatewayPlans> = {}): LibraosGatewayPlans => ({
  plans: [
    {
      id: "pro",
      name: "Pro",
      priceUsd: 20,
      interval: "month",
      summary: "",
      state: "available",
    },
  ],
  current: null,
  manageUrl: "https://console.libraos.com/plans",
  ...overrides,
});

describe("libraosConnection", () => {
  it("is checking until the first status is in, and failed with its message if it cannot be read", () => {
    expect(libraosConnection(reading)).toEqual({ kind: "checking" });
    expect(libraosConnection(failed)).toEqual({
      kind: "failed",
      error: "The environment request failed.",
    });
  });

  it("tells a key the Gateway rejects apart from a connected one and from none", () => {
    expect(libraosConnection(status(false))).toEqual({ kind: "signedOut" });
    expect(libraosConnection(status(true, "Invalid API key"))).toEqual({
      kind: "rejected",
      reason: "Invalid API key",
    });
    expect(libraosConnection(status(true))).toEqual({ kind: "connected" });
  });

  it("keeps the last status it read while a later read fails", () => {
    expect(
      libraosConnection({ data: { connected: true, refusal: null }, error: "x", isSuccess: false }),
    ).toEqual({ kind: "connected" });
  });
});

describe("libraosBalance", () => {
  it("never states a balance it has not read", () => {
    expect(libraosBalance(reading, false)).toEqual({ kind: "reading" });
    expect(libraosBalance(failed, false)).toEqual({
      kind: "failed",
      error: "The environment request failed.",
    });
    // Console answered and has no balance for this account.
    expect(libraosBalance(read(null), false)).toEqual({ kind: "none" });
  });

  it("is used up at zero with no plan, and not merely low", () => {
    expect(libraosBalance(read(credits({ availableUsd: 0 })), false).kind).toBe("usedUp");
    expect(libraosBalance(read(credits({ availableUsd: -0.5 })), false).kind).toBe("usedUp");
    expect(libraosBalance(read(credits({ availableUsd: 1.5 })), false).kind).toBe("low");
    expect(libraosBalance(read(credits()), false).kind).toBe("ok");
  });

  it("does not stop anyone whose plan pays for use or whose account is not limited", () => {
    expect(libraosBalance(read(credits({ availableUsd: 0 })), true).kind).toBe("ok");
    expect(libraosBalance(read(credits({ availableUsd: 0, enforced: false })), false).kind).toBe(
      "ok",
    );
  });
});

describe("libraosPlan", () => {
  it("says No plan only once the plans read confirms it", () => {
    expect(libraosPlan(credits(), reading)).toEqual({ kind: "reading" });
    expect(libraosPlan(credits(), failed)).toEqual({
      kind: "failed",
      error: "The environment request failed.",
    });
    expect(libraosPlan(credits(), read(plans()))).toEqual({ kind: "none" });
    // An older Console sells no plans.
    expect(libraosPlan(null, read(null))).toEqual({ kind: "none" });
  });

  it("names the plan from the balance or the plans, and keeps the id of one it cannot name", () => {
    expect(libraosPlan(credits({ plan: { name: "Team", overage: true } }), reading)).toEqual({
      kind: "named",
      name: "Team",
    });
    expect(libraosPlan(credits(), read(plans({ current: "pro" })))).toEqual({
      kind: "named",
      name: "Pro",
    });
    expect(libraosPlan(credits(), read(plans({ current: "legacy" })))).toEqual({
      kind: "named",
      name: "legacy",
    });
  });
});

describe("libraosPlansList", () => {
  it("shows reading, failed, empty and the plans", () => {
    expect(libraosPlansList(reading).kind).toBe("reading");
    expect(libraosPlansList(failed).kind).toBe("failed");
    expect(libraosPlansList(read(null)).kind).toBe("empty");
    expect(libraosPlansList(read(plans({ plans: [] }))).kind).toBe("empty");
    expect(libraosPlansList(read(plans())).kind).toBe("listed");
  });
});

describe("libraosReadyAgents", () => {
  const agent = (instanceId: string, driver: string, overrides: Partial<ServerProvider> = {}) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(driver),
      displayName: instanceId,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...overrides,
    }) satisfies ServerProvider;
  const nameOf = (provider: ServerProvider) => provider.displayName ?? provider.instanceId;

  it("names the Gateway's ready agents and sees whether another agent is ready", () => {
    const pi = agent(LIBRAOS_GATEWAY_INSTANCE_IDS.pi, "pi", { displayName: "Pi · LibraOS" });
    const gatewayCodex = agent(LIBRAOS_GATEWAY_INSTANCE_IDS.codex, "codex", {
      displayName: "Codex · LibraOS",
      installed: false,
      status: "error",
    });
    expect(libraosReadyAgents([pi, gatewayCodex], undefined, nameOf)).toEqual({
      gateway: ["Pi · LibraOS"],
      othersReady: false,
    });
    expect(
      libraosReadyAgents([pi, agent("claudeAgent", "claudeAgent")], undefined, nameOf),
    ).toEqual({ gateway: ["Pi · LibraOS"], othersReady: true });
  });
});
