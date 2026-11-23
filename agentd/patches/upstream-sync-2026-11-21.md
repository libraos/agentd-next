# Upstream sync 2026-11-21

Merges upstream T3 Code `cbd1f04bca` (2026-11-21, "fix(mobile): Steer interrupts ACP agents without native steering instead of queueing") into `main` at `4eb0edee92`, with a merge commit. 318 upstream commits since the last sync at `badd5f6d18` ([92](92-upstream-sync-2026-11-20.md)). 65 files conflicted and were resolved by [UPSTREAM.md](../UPSTREAM.md): ours for the name, product profile and hidden features, theirs for everything else with our change put back on top.

## What upstream brought

Linked threads and the environments map, structured run output (`submit_output` with an output schema), projects that track several repositories, MCP server sign-in from the app, a "Subagents and side chats" setting, `background_wait` as its own capability, and side chats saved as ordinary thread tabs.

## Resolutions by area

- **Product name in new text.** Upstream's sentence, renamed again: `RestartBackgroundNote.ts`, `RestartContinuation.ts`, `PeerLinks.ts` (link label `AgentD Next · `), `PeerClientPairing.ts`, `PeerThreadRelay.ts`, `McpSignIn.ts`, `ServerBrowser.ts`, `AntigravityInstallation.ts`, `CodexAdapterV2.ts`, `t3ProjectFile.ts`, `runtimeInstructions.ts`, `ssh/tunnel.ts`, the TanStack Source provider, `scripts/build-desktop-artifact.ts`, and the user docs (`faq.md`, `managed-policy.md`, `multi-repo-projects.md`, `remote-access.md`, the provider pages). The checkpoint commit identity in `GitVcsDriver.ts` is `AgentD Next` in its new shared constant too.
- **Commands.** `t3 auth pairing create`, `t3 project add` and `t3 policy settings` are `agentd-next …` in the web and mobile pairing hints and the docs.
- **MCP tool and server names.** New upstream tools and mentions lose the `t3_` prefix: `submit_output`, `thread_read` in `PeerForwarding.ts` (the refusal it matches is our server's wording), `thread_wait`, `thread_send`, `background_wait` in the Cursor adapter, `project_create`, the presentation table in `t3McpToolPresentation.ts`, the eval cases, and the tests beside them. `ClaudeAdapterV2.ts` keeps our `APP_MCP_SERVER_NAME` list with `submit_output` added.
- **Hosted relay.** "T3 Connect" in the new environments map reads "hosted relay". The map only asks the relay for machines when a relay is configured, which our builds do not do.
- **Both sides added something.** Kept both: `AssetAccess.ts`, `codexAuthHandoff.ts`, `rightPanelStore.ts`, `RightPanelTabs.tsx`, `openPullRequestLink.ts`, `ManagedPolicy.test.ts`, `RpcAuthorization.test.ts`, `settingsSearch.test.ts`, `ThreadDetailsUsage.tsx`. In `ProviderSessionManager.ts` our capability set gains upstream's `background-wait`, added only when the session already gets the server. `provider-opencode/v2/adapter.ts` takes upstream's `runtimePolicy` and keeps our `orchestration` argument.
- **Web.** `ChatView.tsx` keeps the `showCodeSurfaces` gate around upstream's new panel props. `Sidebar.tsx` keeps the chat tab's `startChat` before upstream's scoped project ref. `ThreadDetailsPanel.tsx` keeps our single Environment section. `taskPlan.tsx` drops `localOnly`, which `refreshLocalStatusForPicker` now sets itself.
- **Desktop.** `DesktopWslEnvironment.ts` is upstream's, with the runtime parent taken from `DESKTOP_HOME_DIRECTORY_NAME`. The version in `apps/desktop/package.json` stays ours.
- **Deleted files upstream changed.** `.github/VOUCHED.td` and the `agent-context-budget`, `mobile-showcase-screenshots` and `release-desktop` workflows stay deleted.
- **Tests.** Upstream's new tests are renamed the same way: `mcp__agentd-next__` in `evals/mcp-tool-use/run.test.ts` and `ProviderSessionManager.test.ts`, `agentd-desktop.service` in `bootService.test.ts`. `openPullRequestLink.browser.test.tsx` is ours again: upstream's new case opens a pull request from the Issues page, which the product profile hides.
- **Translation catalogs.** Web and mobile: both sides merged, then regenerated. The three sentences renamed in this sync are translated in all nine locales.
- **`agentContextBudget.json`.** Set to the values measured after the merge.

## Left as upstream's

`.agents/skills/launch-video` and the eval prose under `evals/mcp-tool-use` still say T3; neither ships in a build.
