# LibraOS Next

An IDE for working with coding agents. Chat with an agent, work on a project with it, and hand tasks to workers that [LibraOS Engine](https://github.com/libraos/engine) runs, each with a goal, acceptance criteria, a check and a budget.

The app is free and bring-your-own-key: it includes no model access and uses the agent accounts and keys you already have. It runs on macOS, Windows and Linux.

![A project thread with its branch, changes, background tasks and LibraOS Engine workers beside the conversation](agentd/design/shots/session-panel.png)

## Install

Download the installer for your system from the [releases page](https://github.com/libraos/next/releases). LibraOS Engine and its Skills come inside.

| System                | File                                            |
| --------------------- | ----------------------------------------------- |
| macOS (Apple silicon) | `LibraOS-Next-…-arm64.dmg`                      |
| macOS (Intel)         | `LibraOS-Next-…-x64.dmg`                        |
| Windows (x64)         | `LibraOS-Next-…-x64.exe`                        |
| Linux (x64)           | `LibraOS-Next-x86_64.AppImage` or `…-amd64.deb` |

From 0.4.0, the macOS app is notarized by Apple and the Windows installer is signed by Nebula Nova, Inc. Windows SmartScreen may still warn for a while after a release: check that it names Nebula Nova, Inc., then choose **More info → Run anyway**. Linux builds are not signed; check them against `SHA256SUMS`. The [install guide](./docs/user/install.md) covers checksums, older releases and the `lnext` command.

## Connect an agent

The first run lists Claude Code, Codex, opencode and more, and says what each needs: **Install**, **Sign in** or **Turn on**. Use any of these, and mix them:

- **A subscription you already have**, such as Claude Pro or Max, or a ChatGPT plan.
- **An API key or another provider**, set the way that agent documents. A second instance in **Settings → Providers** keeps a key apart from your main login. See the guides for [Claude](./docs/user/providers-claude.md), [Codex](./docs/user/providers-codex.md) and [opencode](./docs/user/providers-opencode.md).
- **LibraOS Gateway**: create a key on the [Console](https://console.libraos.com/api-keys), then open **Use an API key or gateway**, choose **LibraOS Gateway**, paste the key and press **Connect**. Usage is pay as you go, and workers can then take dollar budgets.

Chat and Code need one connected agent and no LibraOS account.

## What you can do

- **Chat or Code.** Code puts the project's files, branch and changes beside the conversation.
- **Hand a task to a worker** with a goal, acceptance criteria, a check and a budget, on this machine or in Cloud Workers.
- **Follow the work** in the session panel: background tasks with live output, and every running worker.
- **Review the result** in the diff viewer.
- **See LibraOS Engine's state**: checks, approvals waiting on you, workers and team nodes.

| First run                                                            | Hand to a worker                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Connect an agent you already use](agentd/design/shots/welcome.png) | ![A task with its goal, criteria, check and budget](agentd/design/shots/hand-to-worker.png) |

## Run from source

You need LibraOS Engine on `PATH` and [Vite+](https://viteplus.dev/guide/) (`curl -fsSL https://vite.plus | bash`). Then:

```sh
vp i
vp run dev           # or: vp run dev:desktop
```

The [development runbook](./docs/operations/00_development.md) covers ports and remote access. [agentd/design/build.md](./agentd/design/build.md) covers building and releasing the installers.

## Contributing

Read [AGENTS.md](./AGENTS.md) first. Design notes are in [agentd/design](./agentd/design), and upstream merges follow [agentd/UPSTREAM.md](./agentd/UPSTREAM.md).

## Licence

[MIT](./LICENSE). Based on [T3 Code](https://github.com/pingdotgg/t3code).
