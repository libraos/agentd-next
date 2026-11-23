# 211 — Word and text-PDF attachments are redacted as text instead of stopping the message

A before-send hook can now read the files it is not shown as text and replace them with text. A hook opts in with `"attachmentFiles": true` in its `before-send` declaration; its stdin's `unshownAttachments` entries then carry `mimeType`, `sizeBytes` and, when the file is on the server, `path` (the pending upload or the stored file). A `rewrite` may return `{id, text, name}` for such an attachment: non-empty text replaces the file, `name` becomes one file name ending in `.txt` (default `<original>.txt`). A hook without the opt-in gets `{id, name}` as before, and naming an unshown attachment in its answer is invalid, which stops the send.

A replacement always goes to review, which lists it in `replacedFiles` (id and the file's own name) and shows its text as the proposed attachment with the file's id. On confirm the server writes the confirmed text, or the proposed text if the client left it out, as a new pending upload `pending-<uuid>-txt` (`text/plain`) and puts it in the send in the file's place; the original pending upload and any text the server extracted beside it (`<file>.txt`) are deleted. A stored, already-sent file is only left out of the send. As with any confirmed review, the hooks do not run again on it.

The redaction plugin (1.1.0) declares `attachmentFiles`, reads `.docx` with the standard library (document, headers, footers, footnotes, endnotes; no comments, no deleted tracked text; no DTDs, part sizes bounded) and PDFs with a text layer with pypdf, redacts the text with the message and the thread's placeholders, and returns every read file as `<name>.txt`, even with nothing to redact, since the file holds more than its text. A PDF with no text is stopped saying it has no text layer; images and other files are stopped as before. `setup_env.py` installs pypdf 7.1.1 and typing_extensions 4.16.0 with `--require-hashes --only-binary :all: --no-deps`.

Ours (no upstream counterpart):

- `agentd/plugins/redact/extract.py` (new), `redact.py`, `setup_env.py`, `agentd-plugin.json`, `README.md`, `tests/documents.py` (new), `tests/test_redact.py`: reading, redacting and replacing files; what is lost.
- `packages/contracts/src/agentdPlugins.ts`: `replacedFiles` on the review.
- `apps/server/src/agentd/pluginCatalog.ts` (+ test): `attachmentFiles`, the richer unshown entries, replacements in a rewrite, `replacementName`.
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): paths for hooks that read files, `replacedFiles`, the replacement upload at confirm.
- `apps/server/src/agentd/redactPlugin.test.ts`: the real plugin with a Word document, a text PDF and a scanned PDF.
- `apps/web/src/components/agentd/BeforeSendControls.tsx` (+ browser test): a replaced file's text says which file it stands for and what is left out.

Upstream files:

- `apps/web/src/i18n/translations/*.json`: the new text in every locale.

Not done: the catalogue in `libraos/plugins` still lists the redaction plugin at 1.0.0; it needs the 1.1.0 entry (new commit sha) before installed copies get file support. Mobile has no review dialog (see 196), so a send from mobile with a Word or PDF file is stopped there as any rewrite is. No OCR.
