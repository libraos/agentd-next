# Layout command approvals cover the repository files they run (#278)

An approval of a project's `worktreeLayout` command was bound to its text only, so a command like
`sh scripts/new-workspace.sh` kept running after the script changed. The stored hash now covers the
text and the content of each existing file inside the project root that the text names. A command
naming no repository file hashes as before, so approvals recorded before this change stay valid
only for such commands; the rest ask again. No schema change: `command_hash` holds the combined
hash, so no migration number is taken from upstream's sequence.

- `apps/server/src/workspace/LayoutCommandApprovals.ts` — hash the command with the repository files it names (inside the project root only), and list those files.
- `apps/server/src/workspace/LayoutCommandApprovalWrites.ts` — record the approval with the hashes of those files, read from the project's folder.
- `apps/server/src/workspace/TaskFolders.ts` — pass the project root to the approval check, and return the covered files with each layout command.
- `apps/server/src/workspace/TaskFolders.testkit.ts` — keep the new `repositoryFiles` method in the wrapped approvals service.
- `apps/server/src/workspace/TaskFolders.test.ts` — a changed or removed script asks again for create and remove; approving again runs it; a change while waiting for the turn is refused.
- `apps/server/src/ws.test.ts` — the mocked layout command carries the new `files` field.
- `packages/contracts/src/workspaceFolders.ts` — `files` on a layout command, defaulting to none from an older server.
- `apps/web/src/components/WorktreeLayoutApprovalDialogHost.tsx` — list the files the approval covers.
- `apps/web/src/components/WorktreeLayoutApprovalDialogHost.browser.test.tsx` — the dialog names the covered files.
- `apps/web/src/components/settings/ProjectWorktreeLayoutSettings.tsx` — list the files each approval covers.
- `apps/web/src/worktreeLayoutApproval.test.ts` — fixtures carry the new `files` field.
- `apps/web/src/i18n/translations/de.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/en.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/es.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/fr.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/ja.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/ko.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/pt-BR.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/ru.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/sv.json` — the sentence before the covered files.
- `apps/web/src/i18n/translations/zh.json` — the sentence before the covered files.
- `docs/user/multi-repo-projects.md` — an approval now covers the files the command names; drop the line saying it did not.

Ours, not upstream's: `apps/server/src/workspace/LayoutCommandApprovals.test.ts` and
`apps/web/src/components/agentd/WorktreeLayoutCommandFiles.tsx`.

Not covered: a file the command reaches only through a variable or a glob, a file a named script
runs in turn, and anything outside the project root (a link inside the root that leads out is
recorded by its target path, never read).
