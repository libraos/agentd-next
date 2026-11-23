import { MessageId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { makeStreamingTimelineFixture } from "~/test-fixtures";
import {
  autoBudget,
  budgetMinutes,
  cloudOfferEnded,
  cloudOfferStarted,
  localBudget,
  cloudPlanProblem,
  conversationTaskDraft,
  defaultCloudPlan,
  defaultModelAccess,
  keyFileProblem,
  rememberKeyFiles,
  modelAccessChoices,
  EMPTY_TASK_FIELDS,
  prepareTaskFields,
  TASK_DRAFT_PROMPT,
  taskDraftReply,
  taskStartProblem,
} from "./startTask.logic";

it("validates the handoff fields before sending the trimmed CLI inputs", () => {
  const fields = {
    ...EMPTY_TASK_FIELDS,
    goal: "  Fix export  ",
    accept: " Keeps sort order \r\n\r\n Does not duplicate rows ",
    check: " pnpm test ",
    budget: " 45m,$3.10 ",
    issue: " libraos/agentd-desktop-next#21 ",
  };
  expect(prepareTaskFields(fields)).toEqual({
    input: {
      goal: "Fix export",
      accept: ["Keeps sort order", "Does not duplicate rows"],
      check: "pnpm test",
      budget: "45m,$3.10",
      issue: "libraos/agentd-desktop-next#21",
    },
    goal: null,
    check: null,
    budget: null,
    accept: false,
    issue: false,
  });
  expect(
    prepareTaskFields({
      ...fields,
      goal: " ",
      check: "--no-check",
      budget: "30m,$0",
      accept: Array.from({ length: 21 }, (_, index) => `Criterion ${index}`).join("\n"),
      issue: "#21",
    }),
  ).toMatchObject({
    goal: "required",
    check: "invalid",
    budget: "invalid",
    accept: true,
    issue: true,
  });
  const noPrices = { dollarBudgets: false };
  expect(prepareTaskFields(fields, noPrices).budget).toBe("no-prices");
  expect(prepareTaskFields({ ...fields, budget: "$2" }, noPrices).budget).toBe("no-prices");
  expect(prepareTaskFields({ ...fields, budget: "45m" }, noPrices).budget).toBeNull();
  expect(prepareTaskFields(fields, { dollarBudgets: true }).budget).toBeNull();
});

it("fills the form only from a completed reply to this draft request", () => {
  const format = (goal: string) =>
    JSON.stringify({
      goal,
      accept: ["Keeps the row order", "Preserves empty cells"],
      check: "pnpm test",
      worker: "opencode",
      budget: "",
      issue: "",
      size: "feature",
    });
  const fixture = makeStreamingTimelineFixture(`\`\`\`json\n${format("Fix export")}\n\`\`\``);
  const date = DateTime.makeUnsafe("2026-11-18T10:00:00Z");
  const provider = ProviderInstanceId.make("opencode");
  const messageId = MessageId.make("live-user");
  const run = {
    id: fixture.runId,
    threadId: fixture.threadId,
    ordinal: 2,
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "fixture" },
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: date,
    startedAt: date,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const turnItems = fixture.visibleTurnItems.map(({ item }) => item);
  const replies = turnItems.filter((item) => item.type === "assistant_message");
  const oldReply = replies.find((item) => !item.streaming)!;
  const reply = replies.find((item) => item.streaming)!;
  expect(conversationTaskDraft({ runs: [run], turnItems }, messageId)).toEqual({ kind: "waiting" });

  const completed = { ...run, status: "completed" as const, completedAt: date };
  const old = { ...oldReply, text: format("Unrelated task") };
  expect(conversationTaskDraft({ runs: [completed], turnItems: [old] }, messageId)).toEqual({
    kind: "failed",
  });
  expect(
    conversationTaskDraft(
      {
        runs: [completed],
        turnItems: [{ ...reply, streaming: false, status: "completed" }, old],
      },
      messageId,
    ),
  ).toEqual({
    kind: "ready",
    fields: {
      goal: "Fix export",
      accept: "Keeps the row order\nPreserves empty cells",
      check: "pnpm test",
      worker: "opencode",
      budget: "",
      issue: "",
      size: "feature",
    },
  });

  // The reply to the draft prompt, and only that, renders as a task card in the conversation.
  const finished = { ...reply, streaming: false, status: "completed" as const };
  const asked = turnItems.map((item) =>
    item.type === "user_message" && item.runId === reply.runId
      ? { ...item, text: TASK_DRAFT_PROMPT }
      : item,
  );
  expect(taskDraftReply(asked, finished)).toMatchObject({ goal: "Fix export", size: "feature" });
  expect(taskDraftReply(turnItems, finished)).toBeNull();
  expect(taskDraftReply(asked, { ...finished, phase: "commentary" })).toBeNull();
  const noSize = { ...finished, text: format("Fix export").replace(',"size":"feature"', "") };
  expect(taskDraftReply(asked, noSize)).toMatchObject({ size: "" });
});

it("fills the budget from agentd's estimate, capped by the cloud balance", () => {
  const estimate = { high: 4.98 };
  expect(autoBudget({ estimate, defaultMinutes: null, balanceUsd: null })).toEqual({
    minutes: 60,
    dollars: 5,
  });
  expect(autoBudget({ estimate: { high: 5 }, defaultMinutes: 30, balanceUsd: null })).toEqual({
    minutes: 30,
    dollars: 5,
  });
  expect(autoBudget({ estimate: { high: 7.01 }, defaultMinutes: null, balanceUsd: 3.456 })).toEqual(
    { minutes: 60, dollars: 3.45 },
  );
  expect(autoBudget({ estimate: null, defaultMinutes: null, balanceUsd: null })).toEqual({
    minutes: 60,
    dollars: 5,
  });
  expect(localBudget({ minutes: 60, dollars: 5 }, true)).toBe("60m,$5");
  expect(localBudget({ minutes: 60, dollars: 5 }, null)).toBe("60m,$5");
  expect(localBudget({ minutes: 45, dollars: 2.5 }, false)).toBe("45m");
  expect(budgetMinutes("45m,$5")).toBe(45);
  expect(budgetMinutes("$5")).toBeNull();
});

it("defaults model access to LibraOS when signed in or the Gateway is connected", () => {
  expect(defaultModelAccess(true, false)).toBe("libraos");
  expect(defaultModelAccess(false, true)).toBe("libraos");
  expect(defaultModelAccess(false, false)).toBe("byok");
});

it("names the first problem that stops a Start", () => {
  const ok = {
    cloud: false,
    balanceUsd: null,
    creditProblem: false,
    modelAccess: "libraos" as "libraos" | "byok" | "subscription",
    planProblem: null as "agentd" | "not-set-up" | null,
    signedIn: false,
    gatewayConnected: false,
    worker: "claude" as const,
    hasDirectory: true,
    branch: null,
  };
  expect(taskStartProblem(ok)).toBeNull();
  expect(taskStartProblem({ ...ok, worker: null })).toBe("worker");
  expect(taskStartProblem({ ...ok, branch: "protected" })).toBeNull();
  expect(taskStartProblem({ ...ok, branch: "detached" })).toBe("detached");
  expect(taskStartProblem({ ...ok, branch: "not-repo" })).toBe("not-repo");
  expect(taskStartProblem({ ...ok, hasDirectory: false })).toBe("no-directory");
  const cloud = { ...ok, cloud: true, signedIn: true, branch: "protected" as const };
  expect(taskStartProblem(cloud)).toBeNull();
  expect(taskStartProblem({ ...cloud, balanceUsd: 0 })).toBe("balance");
  expect(taskStartProblem({ ...cloud, creditProblem: true })).toBe("balance");
  expect(taskStartProblem({ ...cloud, signedIn: false })).toBe("sign-in");
  expect(taskStartProblem({ ...cloud, signedIn: false, gatewayConnected: true })).toBeNull();
  expect(taskStartProblem({ ...cloud, signedIn: false, modelAccess: "byok" })).toBeNull();
  const subscription = { ...cloud, signedIn: false, modelAccess: "subscription" as const };
  expect(taskStartProblem(subscription)).toBeNull();
  expect(taskStartProblem({ ...subscription, planProblem: "not-set-up" })).toBe("subscription");
  expect(taskStartProblem({ ...cloud, planProblem: "agentd" })).toBeNull();
});

it("offers each subscription plan only when agentd can run it and has its credential", () => {
  const plan = (
    state: Partial<{ supported: boolean; configured: boolean; valid: boolean | null }>,
  ) => ({
    supported: true,
    configured: true,
    valid: true as boolean | null,
    expiresAbout: null,
    ...state,
  });
  const both = { claude: plan({}), codex: plan({}), setupUnavailable: false };
  // v0.1.13: no subscription jobs at all.
  expect(modelAccessChoices(null).map((choice) => choice.disabled)).toEqual([false, false, true]);
  expect(modelAccessChoices(both).map((choice) => choice.disabled)).toEqual([false, false, false]);
  expect(cloudPlanProblem(null, "claude", false)).toBe("agentd");

  expect(cloudPlanProblem(both, "claude", false)).toBeNull();
  // valid is null when agentd cannot tell without a job (a ChatGPT login before its report).
  expect(cloudPlanProblem({ ...both, codex: plan({ valid: null }) }, "codex", false)).toBeNull();
  const unset = { ...both, claude: plan({ configured: false, valid: null }) };
  expect(cloudPlanProblem(unset, "claude", false)).toBe("not-set-up");
  expect(cloudPlanProblem(unset, "claude", true)).toBeNull();
  expect(cloudPlanProblem({ ...both, claude: plan({ valid: false }) }, "claude", false)).toBe(
    "invalid",
  );
  expect(cloudPlanProblem({ ...unset, setupUnavailable: true }, "claude", false)).toBe("windows");
  // An agentd too old for ChatGPT refuses it even with a file chosen.
  const claudeOnly = { ...both, codex: plan({ supported: false, configured: false }) };
  expect(cloudPlanProblem(claudeOnly, "codex", true)).toBe("agentd");

  expect(defaultCloudPlan(both)).toBe("claude");
  expect(defaultCloudPlan(unset)).toBe("codex");
  expect(defaultCloudPlan(claudeOnly)).toBe("claude");
  expect(defaultCloudPlan(null)).toBe("claude");
});

it("blocks a key file under the other provider's field, then one others can read", () => {
  const check = (provider: "anthropic" | "openai" | null, openToOthers = false) => ({
    provider,
    readable: provider !== null,
    openToOthers,
  });
  expect(keyFileProblem("openai", check("anthropic"))).toBe("anthropic-key");
  expect(keyFileProblem("anthropic", check("openai", true))).toBe("openai-key");
  expect(keyFileProblem("openai", check("openai", true))).toBe("open-to-others");
  expect(keyFileProblem("anthropic", check("anthropic"))).toBe(null);
  // An unrecognised key is left to agentd; Start waits for the check and stops on a failed one.
  expect(keyFileProblem("openai", { ...check(null), readable: true })).toBe(null);
  expect(keyFileProblem("openai", check(null))).toBe("unreadable");
  expect(keyFileProblem("openai", null)).toBe("checking");
  expect(keyFileProblem("openai", "failed")).toBe("check-failed");
  // A connection without filesystem read leaves the check to agentd on Start.
  expect(keyFileProblem("openai", "not-permitted")).toBe("unchecked");
});

it("remembers accepted BYOK paths without dropping another environment's", () => {
  const latest = { other: { openai: "/b/openai.key" }, here: { anthropic: "/a/old.key" } };
  expect(rememberKeyFiles(latest, "here", { openaiKeyFile: "/a/openai.key" }, 7)).toEqual({
    other: { openai: "/b/openai.key" },
    here: { anthropic: "/a/old.key", openai: "/a/openai.key", openaiSavedAt: 7 },
  });
});

it("reads an offered cloud task as started once its job is past submitting", () => {
  expect(cloudOfferStarted(null, "hof-aa")).toBe(false);
  expect(cloudOfferStarted([{ id: "hof-aa", cloudState: "submitting" }], "hof-aa")).toBe(false);
  expect(cloudOfferStarted([{ id: "hof-aa", cloudState: null }], "hof-aa")).toBe(false);
  expect(cloudOfferStarted([{ id: "hof-bb", cloudState: "running" }], "hof-aa")).toBe(false);
  expect(cloudOfferStarted([{ id: "hof-aa", cloudState: "queued" }], "hof-aa")).toBe(true);
  expect(cloudOfferStarted([{ id: "hof-aa", cloudState: "completed" }], "hof-aa")).toBe(true);
  for (const ended of ["failed", "failed_verification", "cancelled", "budget_exceeded"]) {
    expect(cloudOfferStarted([{ id: "hof-aa", cloudState: ended }], "hof-aa")).toBe(false);
    expect(cloudOfferEnded([{ id: "hof-aa", cloudState: ended }], "hof-aa")).toBe(true);
  }
  for (const open of ["submitting", "queued", "running"])
    expect(cloudOfferEnded([{ id: "hof-aa", cloudState: open }], "hof-aa")).toBe(false);
});
