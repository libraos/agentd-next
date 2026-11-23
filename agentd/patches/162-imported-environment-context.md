# Imported sessions keep Codex's environment context out of the messages

Codex writes the environment it generates for a session (`<environment_context>`) as a user item. An imported session showed it as a user bubble above the real request. Only Codex generates such records; Claude Code and Pi transcripts have none.

- `apps/server/src/project/AgentSessionScanner.ts`: an item Codex marks `environments.environment_context`, or (older Codex, no item kinds) a whole item in that exact form followed by another user item in the same turn, is moved to `environmentContext` instead of the messages. XML a user typed stays a message.
- `apps/server/src/project/AgentSessionImporter.ts`: the import writes that context as an info `system_notice` carrying `importedEnvironment`, ahead of the messages.
- `packages/contracts/src/orchestrationV2.ts`: optional `importedEnvironment` on `system_notice`, in the domain and JSON schemas.
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx`: such a notice renders as the collapsed "Original session environment" row (`apps/web/src/components/agentd/ImportedEnvironmentRow.tsx`), its values as plain text.
