# 87: Contributing guide and user docs name AgentD Next

`CONTRIBUTING.md` was upstream's: it described another project, turned contributions away, told AI
models to decline pull requests and linked upstream's discussions. `docs/user` named the product
"T3 Code" throughout. Docs only; no code changes.

## Files changed

- `CONTRIBUTING.md`: rewritten for this repository: issues, pull requests and the template, the checks
  from AGENTS.md, where AGENTS.md and agentd/UPSTREAM.md are, the fork and the MIT licence. The
  `one-problem` and `verification` anchors stay, since AGENTS.md links the first.
- `docs/user/*.md`: "T3 Code" as the product is "AgentD Next" ("a" became "an"). Bold UI labels and
  quoted messages use what the app shows today, "AgentD Desktop" (patches 24, 67, 85). Unchanged:
  environment variables (`T3CODE_*`), commands (`t3 ...`), paths, URLs, and upstream install names
  (`T3 Code (Alpha)`, `T3 Code (Beta).app`).

## Second pass

The pages the first pass skipped, for upstream-only services, are now done, and
`agentd/design/upstream-only-docs.txt` is deleted.

- `docs/user/install.md`, `faq.md`, `welcome-page.md`, `telemetry.md`, `updating.md`: rewritten for
  this build from the code, README.md and `agentd/design/outbound.md`. They cover the
  `AgentD-Next-<version>-<arch>.<ext>` installers from this repository's releases and `SHA256SUMS`,
  and the `agentd-next` command with its `t3` alias. They also cover the Welcome page's agents,
  LibraOS Gateway, Join a team and Add to PATH, and that no analytics are sent unless
  `T3CODE_POSTHOG_*` is set. Updates mean installing the new release, since there is no feed; a
  mirror (`T3CODE_RELEASE_BASE_URL`, policy `updates.feedUrl`) enables in-app updates. Gone:
  upstream's install script, npx, package managers, Nix, store apps and release channels.
- `t3-connect-troubleshooting.md` was kept here for the relay diagnostics' links; it was later deleted with those links (`233-remove-t3-connect-troubleshooting.md`).
- Deleted, only about upstream services: `guest-links.md` (needs
  the hosted relay's address), `mobile-notifications.md` (push through the hosted relay). Links to
  them in `docs/README.md`, `docs/internals/environment-auth.md`, `remote-access.md` and
  `background-service.md` are removed.
- `remote-access.md`, `outside-agents.md`, `prompt-links.md`, `background-service.md`,
  `managed-policy.md`, `project-settings.md`, `composer.md`, `default-browser.md`,
  `appearance.md`, `devices.md`, `providers-acp.md`: T3 Connect, T3 Chat, app.t3.codes and hosted
  sign-in paragraphs are removed, or replaced by one line saying the service is not part of AgentD
  Next where a reader would look for it. Prompt and thread links show the `agentd-desktop://` and
  `t3-thread://` forms the code builds without a hosted app. SSH hosts and the background service
  need a release mirror, since both download a server runtime.
- Prose "T3 home", "T3 server", "T3 thread", bare "T3" and similar name AgentD Next (several
  pages). Unchanged: `T3CODE_*` variables, `t3 ...` commands, paths such as `~/.t3`, policy keys
  and labels (`"connect"`, **Allow T3 Connect**) and scopes (`relay:read`).

## Not changed

`LICENSE`, `README.md` and the EULA.
