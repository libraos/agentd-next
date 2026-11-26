import type { EnvironmentId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Option from "effect/Option";
import { useMessages } from "gt-react";

import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { SourceControlAppSignInSettings } from "../settings/SourceControlAppSignInSettings";

/**
 * The server's GitHub connection as Settings > Source control shows it: the account, and the same
 * Sign in with GitHub panel. Discovery runs every hosting CLI, so it is asked only while needed.
 */
export function useAgentdGitHubConnection(environmentId: EnvironmentId, needed: boolean) {
  const discovery = useEnvironmentQuery(
    needed ? sourceControlEnvironment.discovery({ environmentId, input: {} }) : null,
    useMessages(),
  );
  const item = discovery.data?.sourceControlProviders.find(({ kind }) => kind === "github");
  const definition = sourceControlClients.find("github");
  const appSignIn = definition?.credentials?.appSignIn;
  const account = item === undefined ? null : Option.getOrNull(item.auth.account);
  const signInPanel =
    definition !== undefined && appSignIn !== undefined && item?.appSignIn === true ? (
      <SourceControlAppSignInSettings
        environmentId={environmentId}
        definition={definition}
        appSignIn={appSignIn}
        account={account}
        onChanged={discovery.refresh}
      />
    ) : null;
  return { account, signInPanel };
}
