import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });
});

describe("mcpToolPresentation known servers", () => {
  it.each(["agentd", "libraos-engine", "libraos_engine", "libraos-core", "Agentd"])(
    "shows the %s server as LibraOS Engine",
    (serverName) => {
      expect(mcpToolPresentation({ toolName: `mcp__${serverName}__handoff_dispatch` })).toEqual({
        title: "handoff dispatch",
        toolSource: {
          key: `mcp:${serverName.toLowerCase()}`,
          name: "LibraOS Engine",
          kind: "integration",
        },
      });
    },
  );

  it("names LibraOS Engine over the display name the provider sends", () => {
    expect(
      mcpToolPresentation({
        serverName: "agentd",
        toolName: "handoff_dispatch",
        serverDisplayName: "agentd",
        source: { name: "agentd" },
        iconUrl: "https://example.com/engine.png",
      }).toolSource,
    ).toEqual({
      key: "mcp:agentd",
      name: "LibraOS Engine",
      kind: "integration",
      icon: { _tag: "themed-logo", logoUrl: "https://example.com/engine.png" },
    });
  });

  it("keeps a third-party server's own name", () => {
    expect(mcpToolPresentation({ toolName: "mcp__agentd_tools__run" }).toolSource?.name).toBe(
      "agentd tools",
    );
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        serverDisplayName: "Weather",
      }).toolSource?.name,
    ).toBe("Weather");
  });

  it("leaves the app's own tools to their own presentation", () => {
    expect(mcpToolPresentation({ toolName: "mcp__agentd-next__thread_start" })).toEqual({});
  });
});
