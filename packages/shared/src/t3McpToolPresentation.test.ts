import { describe, expect, it } from "vite-plus/test";

import {
  T3_MCP_TOOL_NAMES,
  normalizeLegacyAppMcpAllowedTool,
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every LibraOS Next tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__agentd-next__",
        "mcp__agentd_next__",
        "agentd-next-direct.",
        "agentd-next.",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3code.",
        "t3-code-direct.",
        "mcp__t3_code_direct__",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("resolves the legacy t3_-prefixed names that stored history still carries", () => {
    for (const legacy of [
      "mcp__t3-code__t3_thread_list",
      "t3-code-direct.t3_thread_wait",
      "t3_project_read",
      "t3-code-thread_opencode2-adapter_t3_worktree_status",
    ]) {
      expect(resolveT3McpToolPresentation(legacy), legacy).not.toBeNull();
    }
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_thread_list")).toEqual(
      resolveT3McpToolPresentation("mcp__agentd-next__thread_list"),
    );
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("normalizeLegacyAppMcpAllowedTool", () => {
  it("rewrites stored allow-list entries naming the legacy server or tools", () => {
    expect(normalizeLegacyAppMcpAllowedTool("mcp__t3-code__*")).toBe("mcp__agentd-next__*");
    expect(normalizeLegacyAppMcpAllowedTool("mcp__t3-code__t3_thread_list")).toBe(
      "mcp__agentd-next__thread_list",
    );
    expect(normalizeLegacyAppMcpAllowedTool("mcp__t3-code__html_render")).toBe(
      "mcp__agentd-next__html_render",
    );
    expect(normalizeLegacyAppMcpAllowedTool("mcp__other__t3_x")).toBe("mcp__other__t3_x");
    expect(normalizeLegacyAppMcpAllowedTool("Read")).toBe("Read");
  });
});

describe("resolveT3McpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveT3McpToolDefinition("mcp__t3-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveT3McpToolDefinition("preview_type")?.labels);
    expect(resolveT3McpToolDefinition("thread_transfer", { action: "fork" })?.displayName).toBe(
      resolveT3McpToolDefinition("thread_fork")?.displayName,
    );
    expect(resolveT3McpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveT3McpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveT3McpSummaryAction("mcp__t3-code__queue", { action: "list" })).toBe("queue-list");
    expect(resolveT3McpSummaryAction("queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveT3McpSummaryAction("thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveT3McpSummaryAction("thread_configure", {})).toBe("thread-configuration");
    expect(resolveT3McpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveT3McpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
