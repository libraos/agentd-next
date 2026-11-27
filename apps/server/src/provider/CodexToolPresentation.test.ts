import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { mcpToolPresentation } from "./CodexToolPresentation.ts";

type McpToolCallItem = Parameters<typeof mcpToolPresentation>[0];

const mcpToolCall = (server: string, tool: string): McpToolCallItem => ({
  type: "mcpToolCall",
  id: "mcp-call",
  server,
  tool,
  status: "completed",
  arguments: {},
});

describe("CodexToolPresentation.mcpToolPresentation", () => {
  it.effect("shows the agentd server as LibraOS Engine", () =>
    Effect.gen(function* () {
      const presentation = yield* mcpToolPresentation(mcpToolCall("agentd", "handoff_dispatch"));
      assert.deepEqual(presentation, {
        title: "handoff dispatch",
        toolSource: { key: "mcp:agentd", name: "LibraOS Engine", kind: "integration" },
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps a third-party server's name", () =>
    Effect.gen(function* () {
      const presentation = yield* mcpToolPresentation(mcpToolCall("weather", "get_weather"));
      assert.deepEqual(presentation.toolSource, {
        key: "mcp:weather",
        name: "weather",
        kind: "integration",
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
