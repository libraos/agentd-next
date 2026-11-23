import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  resolveClaudeCatalogContextWindowTokens,
  scopeClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("runs Ultracode at the chosen effort and reads the old Ultracode effort as xhigh", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "high" },
          { id: "ultracode", value: true },
        ]),
      ),
    ).toMatchObject({ effort: "high", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }]),
      ),
    ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    const legacyTurnedOff = compileClaudeModelSelection(
      selection("claude-opus-5-5", [
        { id: "effort", value: "ultracode" },
        { id: "ultracode", value: false },
      ]),
    );
    expect(legacyTurnedOff.effort).toBe("xhigh");
    expect(legacyTurnedOff.settings.ultracode).toBe(false);
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "effort", value: "high" }]))
        .settings,
    ).not.toHaveProperty("ultracode");
  });

  it("keeps old Ultracode defaults and selections at Extra High on custom models", () => {
    const customModel = (slug: string, choices: ReadonlyArray<string>) => ({
      slug,
      name: slug,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            currentValue: "ultracode",
            options: choices.map((id) => ({ id, label: id, isDefault: id === "ultracode" })),
          },
        ],
      },
    });
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      customModel("claude-custom-tuned", ["high", "xhigh", "ultracode"]),
      customModel("claude-custom-no-xhigh", ["high", "ultracode"]),
    ]);

    for (const model of ["claude-custom-tuned", "claude-custom-no-xhigh"]) {
      expect(compileClaudeModelSelection(selection(model, []), catalog)).toMatchObject({
        effort: "xhigh",
        settings: { ultracode: true },
      });
      expect(
        compileClaudeModelSelection(
          selection(model, [{ id: "effort", value: "ultracode" }]),
          catalog,
        ),
      ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    }
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles a Gateway's family-prefixed catalog id with that catalog model's options", () => {
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { slug: "anthropic/claude-opus-5-5", subProvider: "anthropic" },
    ]);
    const options = [
      { id: "effort", value: "high" },
      { id: "thinking", value: false },
    ];
    const {
      apiModelId,
      queryIdentity: _full,
      ...compiled
    } = compileClaudeModelSelection(selection("anthropic/claude-opus-5-5", options), catalog);
    expect(apiModelId).toBe("anthropic/claude-opus-5-5");
    const {
      apiModelId: _bare,
      queryIdentity: _own,
      ...own
    } = compileClaudeModelSelection(selection("claude-opus-5-5", options), catalog);
    expect(compiled).toEqual(own);
    expect(compiled.settings).not.toHaveProperty("alwaysThinkingEnabled");
  });

  it("runs a Gateway full id with its catalog model's effort mapping and context window", () => {
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { slug: "anthropic/claude-sonnet-4-6", subProvider: "anthropic" },
    ]);
    const full = selection("anthropic/claude-sonnet-4-6", [
      { id: "effort", value: "max" },
      { id: "contextWindow", value: "1m" },
    ]);
    // Claude Sonnet 4.6 runs Max as high, and 1M only by an id suffix Claude Code would rewrite.
    expect(compileClaudeModelSelection(full, catalog)).toMatchObject({
      apiModelId: "anthropic/claude-sonnet-4-6",
      effort: "high",
    });
    expect(
      getClaudeCatalogModelCapabilities(catalog, full.model).optionDescriptors?.map(
        (descriptor) => descriptor.id,
      ),
    ).not.toContain("contextWindow");
    expect(resolveClaudeCatalogContextWindowTokens(catalog, full)).toBe(200_000);
  });

  it("ignores thinking for catalog models without a thinking option", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "thinking", value: false }]))
        .settings,
    ).not.toHaveProperty("alwaysThinkingEnabled");
  });

  it.each(["gateway-route", "gateway-route[1m]", "gemini/gemini-2.5-pro", "Qwen/Qwen3.5-Plus"])(
    "keeps explicit effort and thinking for %s outside the local catalog",
    (model) => {
      for (const thinking of [true, false]) {
        expect(
          compileClaudeModelSelection(
            selection(model, [
              { id: "effort", value: "max" },
              { id: "thinking", value: thinking },
            ]),
          ),
        ).toMatchObject({
          apiModelId: model,
          effort: "max",
          settings: { alwaysThinkingEnabled: thinking },
        });
      }
      const unconfigured = compileClaudeModelSelection(selection(model, []));
      expect(unconfigured.effort).toBeUndefined();
      expect(unconfigured.settings).toEqual({});
    },
  );
});
