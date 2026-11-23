# Welcome page

LibraOS Next shows a Welcome page, **Connect an agent you already use**, when you
open a new installation. Existing workspaces skip it. You can check your agents,
connect a key or gateway, join a team, and import projects you have used before.
You do not need an account to open the page.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

If LibraOS Next cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If LibraOS Next cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

The Welcome page checks Claude Code, Codex, and opencode on the selected computer.
Open **More agents** to see other agents or browse the ACP Registry. You do not
need to set up all three; **Continue** is available once any agent is ready.
Checked projects are imported when you continue.

- **Turn on** enables an agent that is off on this computer, including one only
  some projects use. LibraOS Next then checks whether it is installed and signed in.
- For Claude Code, Codex, and opencode, **Install** or **Sign in** opens a setup
  terminal. Review the command and press Enter to run it. Installing opencode
  from this page requires npm on the computer running the agent.
- When LibraOS Next knows an installed version does not work with it, **Update** opens
  the agent in **Settings → Providers**, which shows the version to use and updates it
  when it can.
- Other agents, and agents that could not load, open their page in
  **Settings → Providers**.

The setup terminal uses the home directory and environment configured for the
provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

If no agent is ready, **Skip for now** finishes setup without one; connect an
agent later in **Settings → Providers**.

## API keys, gateways and teams

**Use an API key or gateway** lets you choose **LibraOS Gateway** and the agent to
use it with, then paste a **LibraOS API key** and press **Connect**. The key stays
on that environment; **Disconnect** removes it. Codex on the Gateway lists every
model the key allows, and Claude Code all but a few named below, other families
too: a Gemini model under Claude Code shows with `gemini` beside its name. An agent's own models show twice,
by catalog name and by full Gateway id (`openai/gpt-5.5`), with the same options,
except that a full Claude id has no 1M context choice; both run that model,
unless the key also lists the bare id (`gpt-5.5`) as a route of its own: the
catalog-named row then runs that route. Claude Code leaves out the few ids
it would run as another model, such as `best`, `default` or a name ending in
`[1m]`; Codex still lists them.

Connecting also adds **Pi · LibraOS Gateway**, which needs nothing else installed:
LibraOS Next ships Pi and uses it when no `pi` is on your `PATH` (your own
install wins). This Pi keeps its own settings, so your `~/.pi` stays as it is.
If no default model is chosen yet and neither Claude Code, Codex nor opencode
is installed, it becomes the default.

**Custom endpoint** connects any OpenAI- or Anthropic-compatible gateway: enter its
**Endpoint URL**, pick the **Format** (OpenAI adds Codex, opencode and Pi agents,
Anthropic adds Claude Code and opencode agents), add its **Key** (an
Anthropic-format gateway needs one; an OpenAI-format one only if it asks),
and press **Add gateway**; if its model list can't be read, list the **Model ids**
yourself. Other options on that screen show **Not available yet**;
use a provider instance's environment variables for those
([Providers](./install.md#providers)).

**Join a team** takes a **Team invitation link** from your team and enrolls this
device with its LibraOS Core server. Joining needs maintenance access to the
environment.

## The `libraos-next` command

In the desktop app, when the `libraos-next` command is installed but its folder is
not on your `PATH`, the page offers **Add to PATH**, which adds one line to your
shell's startup file ([Install](./install.md#the-libraos-next-command)).

## Projects

LibraOS Next finds directories that Claude Code, Codex or Pi has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The page offers git repositories active within the last 30 days with at least
three conversations, already checked. Projects already in LibraOS Next are not checked
again. Uncheck the box to start without them, or
select **Review all** to pick from everything found, with "Select all" and
"Select none". Linked worktrees of bare repositories
can be offered as separate projects. Conversations in other linked git worktrees
count toward their main checkout, so a repository is offered even if you only
worked in its worktrees. Codex scratch directories under `Documents/Codex`, and
anything under `Downloads` are not offered.

A large or malformed history can reach the scan limit. LibraOS Next keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Claude, Codex and Pi conversations active within the last
30 days. You can continue those conversations in LibraOS Next. Pi is off by default:
open **More agents** and select **Turn on** next to Pi, and the page looks for
its sessions too. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. LibraOS Next keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so LibraOS Next does not remove user text. For Claude, slash commands
and `!` shell commands appear as you typed them; their output, background task
notifications and interruption markers are left out, and a conversation that
only ran commands such as `/clear`, with no reply, is skipped. It reads one
conversation at a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It skips a conversation with more than 100,000
records every time, so opening the page again does not import it. It ignores
malformed records and conversations with no messages, such as a session opened
in an editor but never used. It skips unreadable or unparseable conversations.

Each import attempt reads up to 100 conversations and 4 GiB per project.
Conversations with no messages count toward the 4 GiB but not the 100. To
continue a large batch, open the Welcome page again and pick the project in
**Review all**. Completed conversations are not imported again. You can continue
without the remaining history.

You can start without importing. While an import runs, LibraOS Next stays on the
Welcome page. If you quit, open the Welcome page again from **Settings → About**; the
projects you started stay checked.
