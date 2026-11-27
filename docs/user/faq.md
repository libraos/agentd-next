# FAQ

## What is LibraOS Next?

An IDE for working with coding agents. You chat with an agent, work on a project with it, and hand tasks to workers that [LibraOS Engine](https://github.com/libraos/engine) runs, each with a goal, acceptance criteria, a check and a budget. LibraOS Engine is the authority on tasks, approvals and workers; the app shows them.

## Is LibraOS Next a harness?

No. A harness is what turns a model into an agent: it gives the model tools, runs them and hands the results back. Claude Code, Codex and opencode are harnesses. LibraOS Next starts the harness you already use and shows its work. With none installed, it runs the Pi it ships through a gateway you connect.

Supported: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, and agents from the ACP Registry. [Provider setup](./install.md#providers)

## Can I use LibraOS Next with my Claude Code subscription?

Yes. An agent that is installed and signed in on the machine is used as it is. The same holds for a ChatGPT plan with Codex and for the plans opencode supports. [Welcome page](./welcome-page.md)

## How much does LibraOS Next cost?

The app is free and open source (MIT). It includes no model access and sells none: you pay your provider as you already do. If you use a LibraOS API key through LibraOS Gateway, that use is billed to your LibraOS account, pay as you go from LibraOS credits that you buy from LibraOS in your browser. [LibraOS credits](./welcome-page.md#libraos-credits)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint, or connect LibraOS Gateway from **Use an API key or gateway**. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## How do I use LibraOS Next remotely?

Your agents run wherever the LibraOS Next server runs: your desktop, a server, a VPS. Allow LAN or tailnet access on that machine (**Settings → Sharing & access → Network access** in the desktop app, or `lnext serve --lan`) and pair your other device with a pairing URL. Upstream's hosted relay and hosted web app are not part of LibraOS Next. [Remote access](./remote-access.md)

## Is there a mobile app?

LibraOS Next does not publish one. The store apps are upstream's and not part of LibraOS Next. [Install](./install.md#mobile-app)

## How do I update?

Download the new installer from the releases page and install it over the old one; your data stays. Releases have no automatic update feed. [Updating LibraOS Next](./updating.md)

## Can I add a bunch of accounts for one provider?

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). LibraOS Next does not switch between accounts automatically. For a bigger pool, manage them outside LibraOS Next with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI); LibraOS Next can then show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Does my code go to your servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, and so on), or to LibraOS Gateway if you chose it. LibraOS Next sends no product usage events unless an analytics endpoint is configured, and those events do not include prompts or file contents. Set `T3CODE_TELEMETRY_ENABLED=false` to keep them off even then; diagnostics you export to your own OpenTelemetry receiver are a separate setting. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default, with the option to use a paired environment. On macOS 26 or later, desktop users can choose Apple Speech directly under **On this Mac** or choose an environment. Web and other desktop users can enable dictation by choosing an environment. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes. Installers are built for macOS (Apple silicon and Intel), Windows x64 and Linux x64. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings; version managers often cause this. [Provider setup](./install.md#providers)
