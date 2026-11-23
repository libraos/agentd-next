# 210 — One placeholder map per thread, and replies shown with the originals

The before-send hook's stdin gains `placeholders`, the thread's map from placeholder to original value (`{}` when it has none), and a `rewrite` may return `placeholders`, the map after it. The host adds the returned entries to the thread's map; a hook that returns none leaves it as it was, and one that gives a known placeholder another value, or a placeholder that does not start and end with a mark (such as `[PERSON_1]`), is an invalid answer and stops the send. The map changes only when the person confirms the review: it is kept per thread in `<stateDir>/plugins/placeholders/<sha256 of thread id>.json`, mode 600 in a 700 folder, never in `settings.json`, logs or spans, and deleted on `thread.deleted` and at start for threads that are deleted or gone. If another message of the thread was confirmed while a review waited and numbered the same placeholder for someone else, confirm refuses and asks to send again.

Clients read the map with `agentd.placeholders` (orchestration read, like the review). Web and desktop show an assistant reply's placeholders as the original values, highlighted, with a note under the message, and the copy button and a selection copy give the restored text; code spans keep the placeholder. The agent and provider only ever get placeholders. The review dialog lists the placeholders of the proposed message and marks the ones that are new.

The redaction plugin reuses the thread's placeholders for values in the map, replaces map values even where the detector does not find them again, leaves text that already is a placeholder alone, numbers new values after the highest of each label, and returns the whole map.

Ours (no upstream counterpart):

- `agentd/plugins/redact/redact.py` (+ tests), `README.md`: the map in and out.
- `packages/contracts/src/agentdPlugins.ts`: the map, its input, and the review's placeholders.
- `apps/server/src/agentd/pluginCatalog.ts` (+ test): the map in the hook's stdin, merged from its answer, and its file format.
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): the per-thread file, stored on confirm.
- `apps/server/src/agentd/placeholderCleanup.ts` (+ test): deletes a thread's map with the thread.
- `apps/server/src/agentd/redactPlugin.test.ts`: two sends of the real plugin keep a placeholder.
- `packages/client-runtime/src/state/agentd.ts`, `apps/web/src/lib/agentdState.ts`: the map query.
- `apps/web/src/components/agentd/restorePlaceholders.logic.ts` (+ test), `RestoredPlaceholders.tsx`: restoring text and markdown.
- `apps/web/src/components/agentd/BeforeSendControls.tsx` (+ browser test): new placeholders in the review; the map is read again after confirm.

Upstream files:

- `packages/contracts/src/rpc.ts`: the `agentd.placeholders` RPC.
- `apps/server/src/auth/RpcAuthorization.ts`: it needs orchestration read.
- `apps/server/src/observability/RpcInstrumentation.ts`: it counts as `agentd`.
- `apps/server/src/ws.ts`: its handler.
- `apps/server/src/server.ts`: start the cleanup with the shared plugin service.
- `packages/shared/src/markdownPipeline.ts`: the sanitizer keeps `data-agentd-restored` on a span.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: assistant and sent-message rows render restored values and the note; copy gives restored text.
- `apps/web/src/index.css`: the highlight of a restored value.
- `apps/web/src/i18n/translations/*.json`: the new text in every locale.

Not done: mobile shows replies with placeholders (it has no review dialog either, see 196). Files the agent writes keep their placeholders. Find in thread searches the text as stored, with placeholders. A map written by another client is read again when it is older than 30 seconds and the thread is shown.
