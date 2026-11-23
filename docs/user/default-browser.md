# Use LibraOS Next as your default browser

On macOS, the desktop app can be your default web browser. Links you open from other apps then
open in LibraOS Next. When the thread on screen shows its browser panel, the link opens there as a new
tab. Otherwise it starts a new thread without a project, with the browser panel maximized on the
page, so you can ask an agent about it right away.

Choose **LibraOS Next** under **System Settings → Desktop & Dock → Default web browser**. To go back,
choose another browser there.

Pull request links for a connected project open in the pull request view when opening pull
request links in the app is enabled. Other links still open in the browser panel.

HTML files you open from Finder open the same way. [Prompt links](prompt-links.md) open in the app
as a draft.

A link that launches LibraOS Next waits until the app has connected to its environment, then opens.

## The browser opens beside the agent's work

In a Code thread, the right panel opens on the browser tab when the agent uses the app's
browser, so you can watch the page it is working on. It does not take focus from the composer,
and it leaves an open panel on the tab you chose. If you close the panel, that thread stops
opening it. Turn this off in **Settings > Chat > Open the browser as the agent uses it**.
