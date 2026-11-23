# 1038: The command is libraos-next

The desktop's own command is now `libraos-next` (`libraos-next.cmd` on Windows), decided in dec-03bf28162a for libraos/agentd-core#1038. `agentd-next` and `t3` stay as aliases: the same launcher, the same T3 home and settings, nothing moved. Help, usage, errors and printed commands name `libraos-next`; the root help names the earlier two once.

- **Desktop link.** Install puts `libraos-next` in `~/.local/bin` or `~/bin` (a Windows PATH entry as before) and `agentd-next` and `t3` beside it as links to the same launcher. A file or link under any of those names that the app did not write stays as it is, on Install and on Remove. An earlier `agentd-next` launcher in `<home>/bin` is refreshed at every start but never created, so a link from before keeps working until the user presses Install, which points it at the new launcher. Remove takes all three names, and the legacy `agentd-desktop`, away.
- **Environment.** The server copies every `LIBRAOS_NEXT_<NAME>` over `T3CODE_<NAME>` at startup, before anything reads it, so the new name wins and child processes see one value. `LIBRAOS_NEXT_HOME` is read before `AGENTD_DESKTOP_HOME` and `T3CODE_HOME` by the app as well. No `AGENTD_NEXT_` variables existed. `T3_*` variables are handoffs between the server and its children, not settings, so they have no new name.
- **Not renamed.** The MCP server names (`agentd-next`, `mcp__agentd-next__*`), the npm package name `t3`, the standalone `t3 install` and its runtime layout (`runtime/versions/<v>/t3`), the triage playbook text, and the user-facing strings in the web, mobile and desktop translation catalogs, which the strings rename covers.

## Files

- `agentd/patches/1038-cli-libraos-next.md` — this file.
- `apps/desktop/src/app/DesktopCliCommand.test.ts` — the new name, both aliases, an earlier `agentd-next` install, foreign `agentd-next` and `t3` files left alone.
- `apps/desktop/src/app/DesktopCliCommand.ts` — installs and removes `agentd-next` and `t3` as aliases; messages name `libraos-next`.
- `apps/desktop/src/app/DesktopCliShim.ts` — launcher `libraos-next` with a new marker; earlier markers count as ours; earlier launchers refreshed, never created.
- `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts` — the `LIBRAOS_NEXT_` spelling is cleared too.
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts` — clears `LIBRAOS_NEXT_<NAME>` beside each `T3CODE_<NAME>` the backend must not inherit.
- `apps/server/package.json` — `libraos-next` and `agentd-next` bin entries beside `t3`.
- `apps/server/src/agentd/commandEnvAliases.test.ts` — new: the new variable name first.
- `apps/server/src/agentd/commandEnvAliases.ts` — new: copies `LIBRAOS_NEXT_<NAME>` over `T3CODE_<NAME>`.
- `apps/server/src/bin.ts` — applies the variable aliases first.
- `apps/server/src/binCli.test.ts` — every bin name finds the same home through `LIBRAOS_NEXT_HOME`.
- `apps/server/src/binCli.ts` — command `libraos-next`; help names the aliases.
- `apps/server/src/cli/app.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/app.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/browser.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/config.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/connect.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/environment.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/invocation.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/invocation.ts` — printed commands use `libraos-next` and look for it on PATH.
- `apps/server/src/cli/pair.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/pair.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/runningServer.ts` — credential label `libraos-next cli`.
- `apps/server/src/cli/server.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/service.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/theme.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/thread.ts` — credential label `libraos-next thread cli`.
- `apps/server/src/cli/uninstall.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/up.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/up.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/update.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cli/update.ts` — CLI command `libraos-next`.
- `apps/server/src/cliCompileCache.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/CliTokenManager.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/CliTokenManager.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/CloudLink.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/ConnectReachability.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/bootService.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/relayResponse.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/selfUpdate.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/selfUpdate.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/servicePreflight.test.ts` — CLI command `libraos-next`.
- `apps/server/src/cloud/servicePreflight.ts` — CLI command `libraos-next`.
- `apps/server/src/policy/policyTemplates.ts` — CLI command `libraos-next`.
- `apps/server/src/preview/PreviewBrowserHost.test.ts` — CLI command `libraos-next`.
- `apps/server/src/preview/PreviewBrowserHost.ts` — CLI command `libraos-next`.
- `apps/server/src/serverOwnership.ts` — CLI command `libraos-next`.
- `apps/server/src/serverRuntimeState.test.ts` — CLI command `libraos-next`.
- `apps/server/src/terminal/Manager.test.ts` — `LIBRAOS_NEXT_` variables stay out of terminals.
- `apps/server/src/terminal/Manager.ts` — keeps `LIBRAOS_NEXT_` variables out of terminals, as `T3CODE_` ones are.
- `apps/server/src/triage/triagePrompt.ts` — CLI command `libraos-next` outside the playbook text.
- `packages/shared/src/desktopIdentity.ts` — `CLI_COMMAND_NAME` is `libraos-next`, `CLI_COMMAND_ALIASES` are `agentd-next` and `t3`; `LIBRAOS_NEXT_HOME` read first.
