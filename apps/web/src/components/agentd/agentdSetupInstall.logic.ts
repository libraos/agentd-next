import {
  type DesktopBridge,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";

/**
 * Before Set up LibraOS Engine runs init: installs the desktop app's bundled agentd and its Skills,
 * when the environment is the one this desktop app runs natively. In a WSL backend init runs
 * elsewhere; on the web there is no bundle. A failure leaves init to the agentd it finds.
 */
export async function installAgentdBeforeSetup(input: {
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly bridge:
    | Pick<DesktopBridge, "getLocalEnvironmentBootstraps" | "installAgentd">
    | undefined;
}): Promise<void> {
  const install = input.bridge?.installAgentd;
  if (install === undefined || input.environmentId !== input.primaryEnvironmentId) return;
  const runsHere = input.bridge
    ?.getLocalEnvironmentBootstraps()
    .some(
      (bootstrap) =>
        bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID &&
        typeof bootstrap.runningDistro !== "string" &&
        bootstrap.httpBaseUrl !== null,
    );
  if (runsHere !== true) return;
  await install().catch(() => undefined);
}
