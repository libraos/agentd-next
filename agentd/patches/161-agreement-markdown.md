# 161: The agreement in Set up AgentD renders as formatted text

The agreement from `agentd eula` is Markdown. The Set up AgentD dialog showed it raw (`##`, `**`); it now renders headings (offset so `#` is h3 under the dialog's title) and bold clause labels, with the wording and numbering unchanged. The text comes from the agentd binary, so raw HTML is skipped and only text elements (headings, paragraphs, emphasis, code, lists, links) render: no script, image or iframe.

New, ours:

- `apps/web/src/components/agentd/AgreementMarkdown.tsx`: the restricted renderer (react-markdown, `skipHtml`, allowed elements only).
- `apps/web/src/components/agentd/AgreementMarkdown.test.tsx`: headings and bold, text unchanged against the source minus marks, raw HTML and images dropped.
- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: uses it in place of the earlier `ChatMarkdown` (which renders images and chat-only features).

Upstream files changed: none.
