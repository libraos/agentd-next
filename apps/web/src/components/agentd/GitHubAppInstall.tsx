import type { EnvironmentId } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { isElectron } from "../../env";
import { useAgentdCloudAccount } from "../../lib/agentdState";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

// agentd's own default Job API; any other is a separately hosted one with its own keys and App.
const LIBRAOS_JOB_API = "https://cloud-api.libraos.com";
const LIBRAOS_GITHUB_APP_INSTALL_URL = "https://github.com/apps/libraos/installations/new";

/** The Job API is LibraOS's, so its repository tokens come from the LibraOS GitHub App. */
export function isLibraosJobApi(url: string | null | undefined): boolean {
  return url != null && url.replace(/\/+$/, "") === LIBRAOS_JOB_API;
}

/** A link styled as a button: the desktop opens it in the system browser, the web build follows it. */
export function ExternalLinkButton({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  const open = isElectron
    ? (event: MouseEvent) => {
        event.preventDefault();
        void ensureLocalApi().shell.openExternal(href);
      }
    : undefined;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
      onClick={open}
    >
      {children}
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}

export function InstallGitHubAppButton() {
  return (
    <ExternalLinkButton href={LIBRAOS_GITHUB_APP_INSTALL_URL}>
      <T>Install the GitHub App</T>
    </ExternalLinkButton>
  );
}

/** Why a LibraOS cloud task needs the GitHub App on its repository, with the install page. */
export function GitHubAppNeeded({
  repository,
  alert = false,
  install = true,
}: {
  /** OWNER/REPO; null names "this repository". */
  readonly repository: string | null;
  /** The App is known to be missing, not only required. */
  readonly alert?: boolean;
  /** False where the install button already sits beside this. */
  readonly install?: boolean;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <p role={alert ? "alert" : undefined}>
        {repository === null ? (
          <T>Cloud tasks need the LibraOS GitHub App on this repository.</T>
        ) : (
          <T>
            Cloud tasks need the LibraOS GitHub App on <Var>{repository}</Var>.
          </T>
        )}
      </p>
      {install ? <InstallGitHubAppButton /> : null}
      <p className="text-muted-foreground">
        <T>
          An organization owner or repository admin installs it. Anyone else can request it on the
          same page.
        </T>
      </p>
    </div>
  );
}

/** A finished cloud task's Job API is LibraOS's, as this environment's agentd is set up now. */
export function useLibraosJobApi(environmentId: EnvironmentId): boolean {
  return isLibraosJobApi(useAgentdCloudAccount(environmentId).data?.setupUrl);
}
