# 195 — Local redaction plugin

A before-send plugin in `agentd/plugins/redact/`, to be published in the `libraos/plugins` catalogue. `hook.py` runs `redact.py` in the plugin's own venv (`<stateDir>/plugins/data/redact/`, made by `setup_env.py`), which checks the pinned veil-detect v1.0.0 files by sha256, runs the model card's windowed `detect()` plus rules for e-mail, phone, API keys and tokens, Chinese ID card numbers and unified social credit codes, and prints `rewrite` with placeholders, `pass`, or `block` with how to fix it. The placeholder map and the original text stay in memory.

Ours (no upstream counterpart):

- `agentd/plugins/redact/`: manifest, hook, detection and rules, setup script, Python tests, user README.
- `apps/server/src/agentd/pluginCatalog.ts`: the hook's stdin also lists `unshownAttachments` (id and name), so a hook can stop a send whose attachments it cannot read.
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): passes those attachments to every hook.
- `apps/server/src/agentd/pluginCatalog.ts`, `AgentdPlugins.ts` (+ tests): on Windows a hook or setup declared as `python3` falls back to `py -3`, then `python`, when `python3` is not on PATH or is only the Store alias stub.
- `apps/server/src/agentd/redactPlugin.test.ts`: the plugin's output parsed by `parseHookOutput`.

Upstream files: none.

Not done: the plugin is not in the `libraos/plugins` catalogue yet. Each send starts Python and loads the model (seconds on CPU); a resident detector would be faster. Package versions are pinned but not hash-locked. The page has no setup button; setup is a command the block reason names.
