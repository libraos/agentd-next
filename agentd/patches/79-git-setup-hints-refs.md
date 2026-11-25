# Git setup, install hints and checkpoint refs (#79)

## Missing Git (79-a)

- `apps/server/src/sourceControl/SourceControlRepositoryService.ts` — a clone whose git spawn fails with ENOENT says "Git is not installed" with the platform's install command instead of "The repository could not be cloned."
- `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts` — cover the Windows, Linux and macOS wording.
- `packages/client-runtime/src/operations/projects.ts` — the Git URL source needs setup, with discovery's Git install hint, when discovery reports git missing.
- `packages/client-runtime/src/operations/projects.test.ts` — cover Git URL readiness with git missing, present and not yet discovered.
- `apps/web/src/components/CommandPalette.tsx` — Local folder shows a warning with the same hint when git is missing; it stays usable.

Windows: the ENOENT check reads Effect's spawn error, which is the same on Windows; the winget wording is covered by a test with the platform set to `win32`, not run on a Windows machine. A Git installed while the app runs is found only after the PATH refresh part of #79 lands. Mobile's Git URL row follows the shared readiness; its Local folder row has no warning yet.
