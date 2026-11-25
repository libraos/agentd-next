# LibraOS Core is now LibraOS Engine

The engine the app talks to was renamed on 2026-11-25: LibraOS Core is LibraOS Engine, and its command is `libraos-engine`. `libraos-core` and `agentd` stay working aliases of the same binary. Earlier names: LibraOS Engine was called LibraOS Core (until 2026-11-25) and before that agentd.

- **Text.** Every "LibraOS Core" a person reads says "LibraOS Engine", in every locale. The name stays in Latin script; Korean particles after it follow its final consonant (엔진: 은, 이, 을, 과, 으로), Swedish genitive is "LibraOS Engines".
- **Commands.** Command examples and copyable commands say `libraos-engine`.
- **Lookup.** The desktop app (bundled copy and PATH) and the server's PATH lookup try `libraos-engine`, then `libraos-core`, then `agentd`; a newer name anywhere on PATH wins over an earlier name.
- **i18n.** The web catalogs were regenerated; each locale's translation moved to the renamed string's new key with the name replaced.

Kept: release asset names (`agentd-*`, `libraos-core-*`), the bundle folder `agentd/`, `AGENTD_*` variables, the terminal command the app installs (`agentd`), repository names, and the Workers settings search terms (which now hold both names).

Upstream files changed (files under `agentd/`, `apps/web/src/components/agentd/` and `apps/server/src/agentd/` are ours and not listed):

- `.github/workflows/release.yml`: release notes name LibraOS Engine.
- `README.md`: product name, `libraos-engine` on PATH, Earlier names line.
- `apps/desktop/src/backend/agentdBinary.ts` and its test: looks for `libraos-engine` first.
- `apps/server/src/gateway/LibraosGateway.ts`: engine errors say LibraOS Engine and suggest `libraos-engine`.
- `apps/web/src/components/CommandPalette.tsx`: product name.
- `apps/web/src/components/chat/ThreadDetailsAgentdWorkers.tsx`: product name.
- `apps/web/src/components/chat/ThreadDetailsBackgroundTasks.tsx`: product name.
- `apps/web/src/components/chat/ThreadDetailsPanel.browser.test.tsx`: product name.
- `apps/web/src/components/chat/threadDetailsItems.ts`: product name.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx`: product name.
- `apps/web/src/components/onboarding/JoinTeamScreen.tsx` and its browser test: product name.
- `apps/web/src/components/settings/settingsSearch.ts`: Workers search terms add "libraos engine".
- `apps/web/src/components/sidebar/SidebarChrome.tsx`: product name.
- `apps/web/src/i18n/translations/*.json`: regenerated as above.
- `docs/user/{faq,install,welcome-page,workers}.md`: product name; Earlier names note in install.
- `oxlint-plugin-t3code/rules/no-untranslated-copy.ts`: proper noun LibraOS Engine.
- `packages/client-runtime/src/providerSkills.ts`: comment names LibraOS Engine.
- `scripts/build-desktop-artifact.ts`: comments and the build log name LibraOS Engine.
