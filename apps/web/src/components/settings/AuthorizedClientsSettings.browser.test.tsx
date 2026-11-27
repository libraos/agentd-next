import {
  type AuthPairingCredentialResult,
  EnvironmentId,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
}

const renderHeader = (environmentId: EnvironmentId) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={[]}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });
});

describe("PairingClientsList", () => {
  const expiresAt = "2099-01-01T00:10:00.000Z";
  const created: AuthPairingCredentialResult = {
    id: "link-1",
    credential: "one-time",
    expiresAt: DateTime.makeUnsafe(expiresAt),
    relay: {
      relayUrl: "https://relay.example.com",
      hostId: "host-1",
      hostKey: "host-key",
      deviceToken: "device-token",
    },
  };

  it("puts the server's relay route in the shared link's fragment", async () => {
    await using screen = await render(
      <PairingClientsList
        servedByEnvironment={false}
        endpointUrl="http://192.168.1.20:3773"
        endpoints={[]}
        defaultEndpointKey={null}
        isLoading={false}
        pairingLinks={[
          {
            id: "link-1",
            scopes: [],
            subject: "one-time-token",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt,
          },
        ]}
        createdPairingCredentials={new Map([["link-1", created]])}
        sharedPairingLinkId="link-1"
        clientSessions={[]}
        revokingPairingLinkId={null}
        revokingClientSessionId={null}
        onRevokePairingLink={() => {}}
        onRevokeClientSession={() => {}}
        canRevoke
      />,
    );

    await expect
      .element(screen.getByText(/^http:\/\/192\.168\.1\.20:3773\/pair#/))
      .toHaveTextContent(
        "http://192.168.1.20:3773/pair#token=one-time&relay=https%3A%2F%2Frelay.example.com&host=host-1&hk=host-key&dt=device-token",
      );
  });
});
