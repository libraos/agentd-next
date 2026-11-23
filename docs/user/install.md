# Install AgentD Next

AgentD Next runs coding agents on your computer and lets you control them from its
desktop or web app. Install it on the machine where the agents will work.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch AgentD Next and configure providers afterwards.

## Desktop app

Download an installer from the
[releases page](https://github.com/libraos/agentd-next/releases). Each
release lists its files and a `SHA256SUMS` file; installers are named
`AgentD-Next-<version>-<arch>.<ext>`, except the AppImage, which has no version
in its name so that updates replace it in place.

| System                | File                                               |
| --------------------- | -------------------------------------------------- |
| macOS (Apple silicon) | `AgentD-Next-<version>-arm64.dmg` or `…-arm64.zip` |
| macOS (Intel)         | `AgentD-Next-<version>-x64.dmg` or `…-x64.zip`     |
| Windows (x64)         | `AgentD-Next-<version>-x64.exe`                    |
| Linux (x64)           | `AgentD-Next-x86_64.AppImage` or `…-amd64.deb`     |

From 0.2.0 the app checks for a new release at launch and every four hours, and
asks before installing it (Settings → About also has **Check for Updates**). On
Windows and Linux it downloads and installs the update; on macOS it opens the
release page, and you install the new version by hand. 0.1.10-agentd.8 and
earlier do not check: install 0.2.0 by hand once.

Releases up to 0.1.10-agentd.6 carry the earlier name, AgentD Desktop, in their
file names (`AgentD-Desktop-…`).

Check the download against `SHA256SUMS` before opening it, for example with
`sha256sum` on Linux or `shasum -a 256` on macOS. A matching checksum shows the
file is the one published; it is not a publisher signature. macOS builds are not
notarized and Windows installers are unsigned, so the operating system may warn
the first time you open the app. On macOS, try to open the app once, then use
**System Settings → Privacy & Security → Open Anyway**. On Windows, choose
**More info → Run anyway** in the SmartScreen dialog. Do not override a malware
warning or a block your organization enforces.

The installers include agentd and its Skills. AgentD Next is not in app stores
or package managers such as Homebrew, winget, the AUR or nixpkgs; the packages
there are upstream's and not part of AgentD Next.

If Claude Code, Codex or opencode was connected to agentd by an earlier install
whose agentd is no longer there (for example AgentD Desktop's), AgentD Next
connects that agent again once, with the agentd it carries. An agent you never
connected, or one connected to an agentd that is still there, is left as it is;
if the repair fails, AgentD shows "needs attention" with agentd's own fix.

### Linux

To launch the AppImage, open a terminal in its download folder:

```bash
chmod +x ./AgentD-Next-*x*64.AppImage
./AgentD-Next-*x*64.AppImage
```

To install the `.deb`:

```bash
sudo apt install ./AgentD-Next-<version>-amd64.deb
```

### The `agentd-next` command

The desktop app includes the `agentd-next` command-line tool
(`agentd-next.cmd` on Windows), with `t3` installed beside it as an alias for
scripts written for upstream. A new install sets it up on first launch; after an
update, or any time, choose **Install** next to the command in
**Settings → About**. On macOS and Linux it adds a link in `~/.local/bin` (or
`~/bin`); on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. If the folder is not on your `PATH`, **Add to PATH** on the
Welcome page or in **Settings → About** adds one line to your shell's startup
file. **Remove** takes it off, and the app does not add it again.

| Task                                  | Command                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Start the server and open the web app | `agentd-next`                                                                             |
| Start the server without a browser    | `agentd-next serve`                                                                       |
| Allow access from your other devices  | `agentd-next serve --lan` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `agentd-next service install`, with a release mirror ([details](./background-service.md)) |
| Reclaim database space                | `agentd-next doctor` ([details](./background-service.md#reclaim-database-space))          |

Run `agentd-next --help` for the full reference. If it reports an already running
server, run the `pair` command it names and open the pairing URL to connect to that
server. Stop it before starting a replacement, or use a different `--base-dir` for
an independent server.

There is no install script and no npm package for AgentD Next. To run a server
without the desktop app, build it from source as described in the repository's
README.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. AgentD Next installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
agentd-next app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `agentd-next app ../my-project`, to open another directory. It
requires the desktop app, so a standalone server or an SSH session is not enough. If
the command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `agentd-next app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

AgentD Next does not publish a mobile app. The iOS and Android apps in the app
stores are upstream's and not part of AgentD Next.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from another computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from AgentD Next's provider settings.                                                                                     |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If AgentD Next cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

AgentD Next warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when AgentD Next cannot tell. Claude, Codex, and
OpenCode installs AgentD Next cannot identify stay manual: update them through the
installer you used. AgentD Next runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with AgentD Next. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release AgentD Next tested. When AgentD Next finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, AgentD Next does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but AgentD Next reports a timeout while checking it,
allow more time in the AgentD Next server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 agentd-next serve
```

For a remote environment, set these on the machine running the AgentD Next server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating AgentD Next](./updating.md): install a new release.
- [Managed policy](./managed-policy.md): configure AgentD Next for everyone on a machine.
