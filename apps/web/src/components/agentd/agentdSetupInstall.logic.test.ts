import {
  type DesktopEnvironmentBootstrap,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { installAgentdBeforeSetup } from "./agentdSetupInstall.logic";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");
const native: DesktopEnvironmentBootstrap = {
  id: PRIMARY_LOCAL_ENVIRONMENT_ID,
  label: "This machine",
  runningDistro: null,
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
};

describe("installAgentdBeforeSetup", () => {
  it.each([
    ["the desktop app's own backend", primary, [native], 1],
    ["another environment", remote, [native], 0],
    ["a WSL backend", primary, [{ ...native, runningDistro: "Ubuntu" }], 0],
    ["a local backend that is off", primary, [{ ...native, httpBaseUrl: null }], 0],
    ["no local backend", primary, [], 0],
  ] as const)("on %s installs %i time(s)", async (_, environmentId, bootstraps, calls) => {
    const installAgentd = vi.fn(() => Promise.resolve());
    await installAgentdBeforeSetup({
      environmentId,
      primaryEnvironmentId: primary,
      bridge: { getLocalEnvironmentBootstraps: () => bootstraps, installAgentd },
    });
    expect(installAgentd).toHaveBeenCalledTimes(calls);
  });

  it("waits for the install before init and goes on when it fails", async () => {
    const order: string[] = [];
    const installAgentd = vi.fn(async () => {
      await Promise.resolve();
      order.push("install");
      throw new Error("no handler");
    });
    await installAgentdBeforeSetup({
      environmentId: primary,
      primaryEnvironmentId: primary,
      bridge: { getLocalEnvironmentBootstraps: () => [native], installAgentd },
    });
    order.push("init");
    expect(order).toEqual(["install", "init"]);
  });

  it("does nothing on the web or in a desktop build without the method", async () => {
    await expect(
      installAgentdBeforeSetup({
        environmentId: primary,
        primaryEnvironmentId: primary,
        bridge: undefined,
      }),
    ).resolves.toBeUndefined();
    const getLocalEnvironmentBootstraps = vi.fn(() => [native]);
    await installAgentdBeforeSetup({
      environmentId: primary,
      primaryEnvironmentId: primary,
      bridge: { getLocalEnvironmentBootstraps },
    });
    expect(getLocalEnvironmentBootstraps).not.toHaveBeenCalled();
  });
});
