# Git setup, install hints and checkpoint refs (#79)

## Missing Git (79-a)

- `apps/server/src/sourceControl/SourceControlRepositoryService.ts` — a clone whose git spawn fails with ENOENT says "Git is not installed" with the platform's install command instead of "The repository could not be cloned."
- `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts` — cover the Windows, Linux and macOS wording.
- `packages/client-runtime/src/operations/projects.ts` — the Git URL source needs setup, with discovery's Git install hint, when discovery reports git missing.
- `packages/client-runtime/src/operations/projects.test.ts` — cover Git URL readiness with git missing, present and not yet discovered.
- `apps/web/src/components/CommandPalette.tsx` — Local folder shows a warning with the same hint when git is missing; it stays usable.

Windows: the ENOENT check reads Effect's spawn error, which is the same on Windows; the winget wording is covered by a test with the platform set to `win32`, not run on a Windows machine. A Git installed while the app runs is found only after the PATH refresh part of #79 lands. Mobile's Git URL row follows the shared readiness; its Local folder row has no warning yet.

## Install hints per platform and Windows PATH refresh (79-b)

- `packages/source-control-core/src/shared/installHints.ts` (new) and `packages/source-control-core/package.json` — the Jujutsu, GitHub CLI and GitLab CLI hints, picked by the server's platform: Homebrew on macOS, winget or the jj install page on Windows, distribution packages or the jj install page on Linux.
- `apps/server/src/sourceControl/SourceControlDiscovery.ts` — the jj hint follows the platform; discovery also reads the registry PATH on Windows (`refreshWindowsPath`) next to the login shell refresh, so git, gh, glab and jj installed while the app runs are found.
- `packages/source-control-github/src/server/GitHubSourceControlProvider.ts` — the gh hint follows the platform.
- `packages/source-control-gitlab/src/server/GitLabSourceControlProvider.ts`, `driver.ts` — the glab hint follows the platform through `makeDiscovery`.
- `packages/client-runtime/src/contractLabels.ts` — an INSTALL_HINTS entry for each platform's hint, since clients translate by exact English; `contractLabels.test.ts` checks every platform's hint has one and that Linux and Windows hints never say `brew`.
- `apps/{web,mobile}/src/i18n/translations/*.json` — the new "Install Jujutsu from {url}." text in every locale.

Windows: the PATH refresh and winget wording are covered by tests with the platform set to `win32`, not run on a Windows machine. The "gh is too old" sign-in detail still suggests `brew upgrade gh` on every platform; it is not an install hint.
