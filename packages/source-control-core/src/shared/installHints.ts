// Clients translate these by exact English match: each string needs an entry in
// client-runtime's contractLabels INSTALL_HINTS.
// `platform` is a Node `process.platform` value; this file is shared with clients that lack Node types.

const JJ_INSTALL_PAGE = "https://jj-vcs.github.io/jj/latest/install-and-setup/";

export function jujutsuInstallHint(platform: string): string {
  return platform === "darwin"
    ? "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj."
    : `Install Jujutsu from ${JJ_INSTALL_PAGE}.`;
}

const gitHubCliCommand = (platform: string) => {
  switch (platform) {
    case "darwin":
      return "`brew install gh`";
    case "win32":
      return "`winget install --id GitHub.cli`";
    default:
      return "`sudo apt install gh` or `sudo dnf install gh`";
  }
};

export function gitHubCliInstallHint(platform: string): string {
  return `Install the GitHub command-line tool (\`gh\`) via https://cli.github.com/ or your package manager (for example ${gitHubCliCommand(platform)}).`;
}

const gitLabCliCommand = (platform: string) => {
  switch (platform) {
    case "darwin":
      return "`brew install glab`";
    case "win32":
      return "`winget install --id GLab.GLab`";
    default:
      return "`sudo dnf install glab` or `sudo pacman -S glab`";
  }
};

export function gitLabCliInstallHint(platform: string): string {
  return `Install the GitLab command-line tool (\`glab\`) from https://gitlab.com/gitlab-org/cli or your package manager (for example ${gitLabCliCommand(platform)}).`;
}
