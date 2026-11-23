import * as NodeAssert from "node:assert/strict";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([
      undefined,
      { browser: true, device: true },
      { browser: true, device: true, orchestration: false },
    ])("keeps every entry within Codex's per-entry cap with tools %j", (availability) => {
      const context = buildCodexAdditionalContext(runtime, availability);

      for (const [key, entry] of Object.entries(context)) {
        // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
        const bytes = Buffer.byteLength(entry.value, "utf8");
        const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
        NodeAssert.ok(
          bytes <= limit,
          `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
        );
      }
    });
  });
});

describe("Codex runtime context", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes subagents native first, delegate_task for the rest", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("use your native tool when the child uses your provider"));
    NodeAssert.ok(orchestration.includes("`run_in_background:false`"));
    NodeAssert.ok(orchestration.includes("A native type on another provider's model"));
    NodeAssert.ok(
      orchestration.includes("Background agent: `delegate_task`, never a background `Agent`."),
    );
    NodeAssert.ok(
      orchestration.includes("Every new delegate review or re-check is a new `delegate_task`"),
    );
    NodeAssert.ok(orchestration.includes("never a `thread_send`"));
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

describe("Codex context without orchestration tools", () => {
  // Told to call orchestrator_capabilities/delegate_task, which an AgentD thread does not list,
  // Codex reported them unavailable and stopped instead of using the AgentD skill.
  it("sends no orchestration sections and points worker requests at the AgentD skill", () => {
    const context = (orchestration: boolean) =>
      Object.values(
        buildCodexAdditionalContext(
          { model: "gpt-6.1-sol" },
          { browser: true, device: false, orchestration },
        ),
      )
        .map((entry) => entry.value)
        .join("\n");

    for (const section of T3_CODE_ORCHESTRATION_SECTIONS.slice(0, 2)) {
      NodeAssert.ok(context(true).includes(section));
      NodeAssert.ok(!context(false).includes(section));
    }
    NodeAssert.ok(!context(false).includes("Call `orchestrator_capabilities`"));
    NodeAssert.ok(context(false).includes("AgentD skill"));
    NodeAssert.ok(context(false).includes("html_preview"));
  });
});

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    const tools = (device: boolean) =>
      buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, { browser: true, device }).t3_code_tools
        ?.value ?? "";

    NodeAssert.ok(tools(true).includes(T3_CODE_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## T3 Code devices"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
