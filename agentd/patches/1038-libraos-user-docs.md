# 1038: User docs name LibraOS Next and LibraOS Core

Part of the LibraOS rebrand (libraos/agentd-core#1038): the app AgentD Next is now LibraOS Next, and
agentd, the component it reads tasks, approvals and workers from, is LibraOS Core (command
`libraos-core`, with `agentd` kept as an alias). Docs only; no code changes.

## Files changed

- `docs/user/*.md`: the product "AgentD Next" is "LibraOS Next"; agentd as the component is "LibraOS
  Core". Bold UI labels and quoted messages that still said "AgentD Desktop" use the name the app
  shows after the rename: **LibraOS Next** (default browser, Group Policy category, the restart
  message, About on mobile, the GNOME extension, **Open pull requests in LibraOS Next**, **viewed in
  LibraOS Next**).
- `docs/user/install.md`: installers are `LibraOS-Next-*`; earlier releases carry the AgentD Next and
  AgentD Desktop names; an AgentD Next install is moved to LibraOS Next by hand once.
- `docs/user/updating.md`: a section on moving from AgentD Next: LibraOS Next installs beside it and
  copies its app data on first start, leaving the old copy.
- `docs/user/prompt-links.md`: links use `libraos-next://`; `agentd-desktop://` links still open the
  app.

## Not changed

- The attribution: LibraOS Next is a fork of T3 Code, MIT (`agentd/UPSTREAM.md`, `README.md`).
- Repository URLs (`libraos/agentd`, `libraos/agentd-next`), which are renamed only after these
  changes merge.
- The `agentd-next` command and its `t3` alias, the `agentd/` directory, `AGENTD_RELEASE`, release
  version strings such as `0.1.10-agentd.6`, environment variables, paths and anchors.
