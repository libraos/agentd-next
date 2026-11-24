# Contributing

Thank you for helping with AgentD Next. This page says how to report a problem, how to open a pull
request, and which checks to run.

## Report a problem or ask for a change

Open an issue on [libraos/next](https://github.com/libraos/next/issues).
Search first, in case someone already reported it.

- For a bug, say what you did, what you expected, and what happened instead. Add the app version,
  your operating system, and the agent you used (Claude Code, Codex, opencode or another).
- For a change, say what you want to do and why the app does not let you do it today.
- Do not include credentials, personal data or confidential information in issues, pull requests, logs, screenshots or videos.

## Open a pull request

1. Fork the repository, or create a branch if you have write access.
2. Read [AGENTS.md](AGENTS.md). It holds the rules for this repository, for people and for coding
   agents: where our code lives, how to test, and how to write commits.
3. Make the change. Keep changes to files that come from upstream small, and list each one in a note
   under [agentd/patches/](agentd/patches/), as AGENTS.md describes.
4. Run the checks below.
5. Open the pull request and fill in the
   [pull request template](.github/pull_request_template.md): the problem, the change, its scope and
   how you verified it.

Use a conventional commit title in plain language, such as
`fix(web): new threads no longer spike CPU`.

<a id="one-problem"></a>

### One problem per pull request

Fix one problem. Include every change that fix needs across contracts, server, clients, tests and
docs. Cleanup, refactors and a second fix go in their own pull requests.

<a id="verification"></a>

### Show that it works

Say how you checked the change and what you saw. "Tests pass" alone is not enough. A UI change needs
before and after screenshots, and a short video when it is about motion or timing. Upload them to the
pull request; do not commit them.

If a coding agent did the work, name the model and the tool at the end of the description.

## Checks to run

- `vp i` installs the dependencies.
- `vp test run <files>` runs the tests for the files you changed while you work.
- `vp run check:changed` runs CI's fast checks for the files you changed before you push: format,
  lint, typecheck and the tests beside your changes.

CI runs the full test suites, so you do not need to run them yourself. The
[development runbook](docs/operations/development.md#first-checkout) explains how to set up a checkout
and run the app.

## Upstream

AgentD Next is a fork of [T3 Code](https://github.com/pingdotgg/t3code). [agentd/UPSTREAM.md](agentd/UPSTREAM.md) says how we merge upstream's changes and resolve conflicts.
A fix that belongs upstream is best sent there too.

The project is released under the MIT licence; see [LICENSE](LICENSE). By submitting a contribution for inclusion in AgentD Next, you license it under the MIT licence in LICENSE and confirm that you have the right to do so, including any required permission from your employer or other rights holders.
