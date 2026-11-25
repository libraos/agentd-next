# 213: Codex's Ultra effort, labelled and sent on thread start

Issue #213 asked for a setting for Codex's multi-agent mode. Codex ignores that field: its schema marks
`thread/start.multiAgentMode` and `turn/start.multiAgentMode` "@deprecated Ignored. Use `effort: "ultra"`
for proactive multi-agent behavior", and `thread/resume` has no such field (Codex 0.166, 0.167 and
0.169). The user rescoped the issue to Codex's Ultra effort.

Codex's `model/list` already lists `ultra` for the models and versions that accept it (on 0.169 every
model except the Luna ones), and the effort picker showed it as "Ultra" with no word on what it does. Now:

- The Ultra option says "Delegates to sub-agents on its own, so it costs more", in every language.
- Choosing it sends `effort: "ultra"` on `turn/start` as before, and also on `thread/start`. That request
  has no effort field, so it goes as `config.model_reasoning_effort` (checked live on 0.169: the thread
  reports `reasoningEffort: "ultra"`; a model without Ultra falls back to its default). Other levels
  still go on `turn/start` only. A context handoff starts its new thread and turn with the run's model
  selection, so it keeps Ultra like any other level.
- Managed Codex (ChatGPT token sharing) runs with multi-agent off, so its models do not offer Ultra, and
  a saved Ultra choice reaching it is dropped from both requests.

Custom Codex models keep their fixed Low to Extra High presets: we cannot know whether they accept Ultra.

Upstream files changed:

- `apps/server/src/provider/CodexProvider.ts`: a description for the `ultra` effort option, and
  `managedCodexModelCapabilities`, which removes service tiers (moved here) and Ultra for managed Codex.
- `apps/server/src/provider/Drivers/CodexManagedProvider.ts`: uses `managedCodexModelCapabilities`.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: `codexSelectedReasoningEffort` and
  `codexThreadStartEffort`; Ultra goes into the `thread/start` config; managed Codex never sends it.
- `packages/client-runtime/src/modelTraits.ts`: `providerOptionDescription` translates the
  server's English Ultra description.
- `apps/web/src/components/chat/ComposerModelEffort.tsx`, `apps/web/src/components/chat/TraitsPicker.tsx`,
  `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx`: show option descriptions through it.
- `apps/{web,mobile}/src/i18n/translations/*.json`: the new description in every language.
- Tests: `CodexProvider.test.ts`, `CodexAdapterV2.test.ts`.
