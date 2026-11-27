# Plugin catalogues

**Plugins** in the sidebar (or **Open plugins** in the command palette) installs plugins from the official LibraOS catalogue and from any GitHub
repository that holds a `catalog.json` in the same format, such as your organisation's own.

## Add a catalogue or install one of its plugins

Paste one of these into **Repository or link** and choose **Add catalogue**:

- the repository, such as `github.com/acme/plugins`;
- its `catalog.json` link;
- a plugin's folder link, such as `github.com/acme/plugins/tree/main/plugins/review`. This adds the
  catalogue if needed and opens that plugin's install dialog.

A plugin link only opens a plugin the catalogue lists, and only from that same repository. What is
installed is the version the catalogue pins, whichever branch the link names. A link never adds a
folder on your computer; use developer mode for that.

## Private catalogues

A private repository can be read in two ways:

- **Your GitHub connection.** The first time, LibraOS Next asks whether to use the GitHub
  connection from [Source control](./source-control.md) for that repository, naming the account.
  It uses the GitHub App where the app is installed on the repository, and otherwise your own
  GitHub sign-in or `gh` login. It asks once per catalogue; removing the catalogue asks again next
  time. When nothing is connected, the dialog offers **Sign in with GitHub**; on a server without
  the app, run `gh auth login` on the computer LibraOS Next runs on and try again.
- **A token.** Give a fine-grained, read-only token for that repository (Contents: read) in
  **Token**. It is kept on the server and deleted when you remove the catalogue.

Either is sent only to GitHub's API for that repository. Plugins never keep your GitHub
connection's credential.

A renamed private repository has to be added again under its new name.
