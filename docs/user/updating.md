# Updating LibraOS Next

## Update the desktop app

LibraOS Next releases have no automatic update feed. **Settings → About** says
"Automatic updates are not available because no update feed is configured."
To update, download the new installer from the
[releases page](https://github.com/libraos/agentd-next/releases), check it
against `SHA256SUMS`, and install it over the old version (see
[Install LibraOS Next](./install.md#desktop-app)). Your threads, settings and data
stay, since the new version uses the same app id and data folder.

### From AgentD Next

LibraOS Next is the new name of AgentD Next, and it installs as a new app beside
it: an AgentD Next install does not update itself to LibraOS Next. Install
LibraOS Next once by hand. On its first start it copies the app data of AgentD
Next and leaves AgentD Next's own copy as it is, so your threads and settings
carry over. Delete AgentD Next once LibraOS Next works for you; after that,
updates install over LibraOS Next as above.

On macOS, a version that carried an earlier name, `AgentD Desktop.app` or
`AgentD Next.app`, stays in Applications after you install `LibraOS Next.app`.
Delete the old app.

An administrator can point the desktop app at their own update mirror with the
managed policy's `updates.feedUrl` ([Managed policy](./managed-policy.md#updates)).
With a mirror set, the desktop app checks it and installs updates itself.

## Update a server

A server you run with `agentd-next` from the desktop app updates with the app. The
`agentd-next update` command and the **Update server** action for remote servers
need a release mirror: set `T3CODE_RELEASE_BASE_URL` on the server's machine to a
mirror laid out like a GitHub release's downloads, or use the managed policy's
`updates.feedUrl`. Without one they report "Updates are not configured for this
build" and make no network request. With `T3CODE_RELEASE_BASE_URL` set, the server also
looks up release information for the npm package `t3`, through `npm` or, when npm is not
installed, the public npm registry. For a server built from source, update it with
`git pull` and a rebuild.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
LibraOS Next must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, a Claude
monitor, or a command or other monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three consecutive crash recoveries
of an unfinished turn, the thread waits for your next message, even when crashes
are more than five minutes apart. A completed turn or a planned shutdown resets
that limit.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older LibraOS Next versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  LibraOS Next on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a LibraOS Next home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. A provider is left out
when any of its enabled, outdated instances offers only a manual update command,
or when its instances use different update commands, such as two instances that
run different CLI installs. Update those by hand, or point every instance of the
provider at the same CLI.

After a successful provider CLI update, LibraOS Next refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. The model catalog is the
one bundled with the release; a server downloads a newer one only when
`T3CODE_MODEL_MANIFEST_URL` names it and provider update checks are on.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.
