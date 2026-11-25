# LibraOS Engine in the app's text

The engine LibraOS Next bundles and talks to (agentd) is now called LibraOS Engine instead of LibraOS Core. This patch renames it in every string a person reads in `apps/web`, `apps/server`, `apps/desktop`, `apps/mobile`, `packages`, `docs/user` and `README.md`, the same way `1038-libraos-rename-i18n.md` renamed AgentD to LibraOS Core.

## Renamed

- **Text.** "LibraOS Core" became "LibraOS Engine" everywhere it was read: the LibraOS Engine page, sidebar button, command palette entry and status indicator, setup and Repair dialogs, Start task and Cloud Workers messages, the Workers settings, the session panel, team join, the Gateway sign-in screen, and the engine errors the server reports (`AgentdBridge`, `agentdCloud`, `cloudFailure`, `AgentdTeamNode`, `AgentdPlugins`, `LibraosGateway`, `agentdCommands`). Mobile had no "LibraOS Core" strings; desktop had one comment.
- **Agent prompt.** The task-draft prompt (`TASK_DRAFT_PROMPT`) asks for a "LibraOS Engine worker task". No eval covers that prompt, and no real provider was run.
- **Docs.** `README.md`, `docs/user/faq.md`, `install.md`, `welcome-page.md` and `workers.md` say LibraOS Engine. Two sentences keep the old name to explain it: the README's earlier-names sentence ("the engine was formerly LibraOS Core") and install.md's repair paragraph ("LibraOS Engine (formerly LibraOS Core, and agentd before that)").
- **Lint.** The `no-untranslated-copy` brand list names LibraOS Engine instead of LibraOS Core.
- **i18n.** The web catalog was regenerated. Every renamed string gets a new key, so each locale's earlier translation was carried over to its new key with the brand replaced (101 strings in each of the 10 locales, all matched; none lost; two English texts that appear under two keys each had the same translation under both). The mobile and desktop catalogs did not change. Brand names stay in Latin script. Grammar around the brand was adjusted where the old form no longer fits:
  - German treats the engine as feminine, like "die Unreal Engine": `das`/`dem`/`ein`/`einem`/`dein eigenes LibraOS Core` became `die`/`der`/`eine`/`einer`/`deine eigene LibraOS Engine`, relative pronouns `das` became `die`, `einer seiner Hintergrunddienste` became `einer ihrer`, and compounds `LibraOS-Core-Seite` became `LibraOS-Engine-Seite`.
  - Korean particles follow the final consonant of 엔진: `가`→`이`, `를`→`을`, `는`→`은`, `와`→`과`, `로`→`으로`; `의` and `에` are unchanged.
  - Swedish genitive `LibraOS Cores` became `LibraOS Engines`; `LibraOS Core-sidan` became `LibraOS Engine-sidan`.
  - French, Spanish and Portuguese keep their masculine articles (`le`, `el`, `o`: moteur, motor). Russian, Japanese and Chinese needed no change around the brand.
- **Search.** The Workers settings search terms add `libraos engine` in front of `libraos core agentd`, so both the new and the old names find the page.

## Kept, and why

- The `libraos-core` command and its `agentd` alias, in command examples and copyable commands: the binary is not renamed.
- `AGENTD_*` environment variables (no `LIBRAOS_CORE_*` variable appears in this app's code), paths, `agentd-watchdog.timer` and other unit names, `mcp__agentd__*` tool names, storage keys and atom labels: renaming them would break existing installs.
- Repository URLs: they already point at `github.com/libraos/engine`.
- The search terms `libraos core` and `agentd`, so someone searching an old name still finds the Workers page.
- Outside this patch's scope: `.github/workflows/release.yml` release notes, `scripts/build-desktop-artifact.ts` build logs, `agentd/design/next-agentd-names.md`, `agentd/UPSTREAM.md` and `agentd/scripts/build-desktop.sh` still say LibraOS Core. Earlier patch notes (`1038-*.md`) record the earlier rename and stay as they are.
- The agreement itself comes from the engine and is not edited here. `AgreementMarkdown.test.tsx` only shapes a sample after it; its sample sentence says LibraOS Engine.

## Files

The web catalogs (`apps/web/src/i18n/translations/*.json`) were regenerated as above. Files under `apps/web/src/components/agentd/` and `apps/server/src/agentd/` are ours and not listed. Every other file:

- `README.md` — engine name LibraOS Engine; earlier-names sentence.
- `apps/desktop/src/backend/agentdBinary.ts` — engine name in a comment.
- `apps/server/src/gateway/LibraosGateway.ts` — engine name LibraOS Engine.
- `apps/web/src/components/CommandPalette.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/chat/ThreadDetailsAgentdWorkers.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/chat/ThreadDetailsBackgroundTasks.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/chat/ThreadDetailsPanel.browser.test.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/chat/threadDetailsItems.ts` — engine name LibraOS Engine.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/onboarding/JoinTeamScreen.browser.test.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/onboarding/JoinTeamScreen.tsx` — engine name LibraOS Engine.
- `apps/web/src/components/settings/settingsSearch.ts` — search terms add `libraos engine`.
- `apps/web/src/components/sidebar/SidebarChrome.tsx` — engine name LibraOS Engine.
- `docs/user/faq.md` — engine name LibraOS Engine.
- `docs/user/install.md` — engine name LibraOS Engine; repair paragraph names the earlier names.
- `docs/user/welcome-page.md` — engine name LibraOS Engine.
- `docs/user/workers.md` — engine name LibraOS Engine.
- `oxlint-plugin-t3code/rules/no-untranslated-copy.ts` — brand list names LibraOS Engine.
- `packages/client-runtime/src/providerSkills.ts` — engine name in a comment.
