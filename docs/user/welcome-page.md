# Welcome page

LibraOS Next shows a Welcome page, **Welcome to LibraOS Next**, when you open a
new installation. Existing workspaces skip it. You can check your agents, sign in
to LibraOS, connect a key or gateway, and import projects you have used before.
You do not need an account to open the page. To join a team, use **Join a team**
in Settings.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

If LibraOS Next cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If LibraOS Next cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

The first row is **LibraOS**: models through LibraOS Gateway, paid as you go,
with no agent to install. **Sign in** opens LibraOS in your browser; sign in or
create an account there and click **Approve**. Until you do, the page shows only
the code to check, **Open LibraOS again** and **Cancel**; a code that expired
offers **Get a new code**. Once you are connected, the row names the Gateway's
agents that are ready and your balance, and **Manage** opens the LibraOS Gateway
screen. When the credits are used up, the row says so and offers **Buy credits**.

Below it, the Welcome page checks Claude Code, Codex, and opencode on the selected
computer. Open **More agents** to see other agents or browse the ACP Registry. You
do not need to set up all three; **Continue** is available once any agent is
ready, including the Pi that LibraOS adds when you sign in. Checked projects are
imported when you continue.

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

## API keys and gateways

**Use an API key or custom gateway**, below the agents, lets you choose **LibraOS Gateway** and the agent to
use it with, then **Sign in with LibraOS**: your browser opens to sign in or
create a LibraOS account and approve a code, and LibraOS makes a key for this
environment. **Use an API key instead** takes a **LibraOS API key** you paste.
The key stays on that environment; **Disconnect** removes it. Codex on the Gateway lists every
model the key allows, and Claude Code all but a few named below, other families
too: a Gemini model under Claude Code shows with `gemini` beside its name. An agent's own models show twice,
by catalog name and by full Gateway id (`openai/gpt-5.5`), with the same options,
except that a full Claude id has no 1M context choice; both run that model,
unless the key also lists the bare id (`gpt-5.5`) as a route of its own: the
catalog-named row then runs that route. Claude Code leaves out the few ids
it would run as another model, such as `best`, `default` or a name ending in
`[1m]`; Codex still lists them.

Connecting adds agents named **Claude Code · LibraOS**, **Codex · LibraOS**,
**opencode · LibraOS** and **Pi · LibraOS**. Pi needs nothing else installed:
LibraOS Next ships Pi and uses it when no `pi` is on your `PATH` (your own
install wins). This Pi keeps its own settings, so your `~/.pi` stays as it is.
If no default model is chosen yet and neither Claude Code, Codex nor opencode
is installed, it becomes the default.

### LibraOS credits

Gateway use is paid from your LibraOS credits. While the Gateway is connected, its
panel, the **LibraOS** card at the top of **Settings → Providers** and the
**Usage** page show the balance. To get there from anywhere,
search Settings for "credits" or run **Buy LibraOS credits** from the command
palette.

Choosing an amount under **Buy credits** opens Stripe Checkout in your browser.
You pay there; the app never sees your card. The balance refreshes when you come
back to the app, and a payment can take a few seconds to show. **Manage billing**
opens the Credits page of the LibraOS Console, which is also where you buy if
the app cannot start a checkout.

When the credits run out, a Gateway agent's turn stops with **Your LibraOS
credits have run out.** Buy credits, then press **Retry** to continue where the
agent stopped. Pi cannot resume a turn, so with Pi send a message instead. A
used-up Token Plan shows the same card with **Buy credits**. Starting a cloud
worker without enough credit offers **Buy credits** too.

### LibraOS plans

**Plans**, beside **Buy credits**, lists the plans LibraOS offers, with their price
and what each includes. **Subscribe** opens Stripe Checkout in your browser, as
buying credits does; the plans refresh when you come back to the app. Your plan
shows as **Current plan**, and **Manage plan** opens the LibraOS Console, where
you change or cancel it. A plan marked **Coming soon** cannot be chosen yet. The
out-of-credits card offers **See plans** too. To get there from anywhere, search
Settings for "plans" or run **See LibraOS plans** from the command palette. When
LibraOS has no plans to show here, **See plans** opens the LibraOS Console
instead, and the out-of-credits card offers only **Buy credits**.

With **Custom endpoint**, enter a gateway URL with or without a trailing `/v1`.
Without a name, the gateway is named after the URL's host, such as
`gateway.example.com`. Settings → Providers lists it under **Your gateways**.
Choose **Both** to use one URL and key with Claude Code, Codex, opencode, and Pi.
**OpenAI** supports Codex, opencode, and Pi. **Anthropic** supports Claude Code
and opencode. A key is required for **Both** and **Anthropic**. If the model list
can't be read, enter the **Model ids** yourself.

A gateway whose certificate comes from your own certificate authority works once
that CA is in the system certificate store (`update-ca-certificates` on Linux,
Keychain Access on macOS, the certificate manager on Windows). Restart LibraOS
Next after adding the CA; it reads the store when it starts.

After saving one format, use the action below the form to add the other format
to the same gateway. In the model picker, look for the gateway name to select
the instance that uses it.

A gateway runs through its agents, so its Claude Code source needs Claude Code
installed on that computer. Until it is, the model picker shows that source as
needing Claude Code, and **Install** opens the step that installs it. The same
holds for Codex and opencode.

**Join a team**, in the Settings sidebar, takes a **Team invitation link** from
your team and enrolls this device with its LibraOS Engine server. Joining needs
maintenance access to the environment.

## The `lnext` command

In the desktop app, when the `lnext` command is installed but its folder is
not on your `PATH`, the page offers **Add to PATH**, which adds one line to your
shell's startup file ([Install](./install.md#the-lnext-command)).

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
