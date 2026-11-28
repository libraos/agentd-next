import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { RelayHostDevice } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useRelayHostCommands, useRelayHostStatus } from "~/lib/relayHostState";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { formatAccessTimestamp } from "../settings/ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";

/** Settings → Relay: what `lnext relay status|devices|revoke` show and do, for this computer. */
export function RelaySettings() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const query = useRelayHostStatus(environmentId);
  const { canRevoke, revokeDevice } = useRelayHostCommands(environmentId);
  const status = query.data;

  if (environmentId === null) return null;
  if (!query.isPending && status === null && query.error === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="relay" title={gt("Relay")}>
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            <T>This connection cannot view this computer&apos;s relay or its devices.</T>
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="relay" title={gt("Relay")}>
        {query.error !== null && status === null ? (
          <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
            {gt("The relay settings could not be read: {error}", { error: query.error })}
          </p>
        ) : status === null ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4" aria-busy="true">
            <T>Reading the relay settings…</T>
          </p>
        ) : status.relay === null ? (
          <SettingsRow
            id="relay-off"
            title={gt("Off")}
            description={
              <T>
                This computer is not connected to a relay. Connect it with{" "}
                <code>lnext relay connect &lt;relay-url&gt; --token &lt;token&gt;</code> so paired
                phones reach it from any network.
              </T>
            }
          />
        ) : (
          <>
            <SettingsRow
              id="relay-route"
              title={gt("Relay")}
              description={
                status.relay.hostId === null
                  ? gt("The relay has not told this computer its host id yet.")
                  : gt("Host id {hostId}", { hostId: status.relay.hostId })
              }
              control={<span className="break-all text-sm">{status.relay.relayUrl}</span>}
            />
            <SettingsRow
              id="relay-connection"
              title={gt("Connection")}
              description={
                status.relay.online
                  ? gt("The server is connected to the relay; paired devices can reach it.")
                  : gt(
                      "The server is not connected to the relay right now. It retries on its own while it runs.",
                    )
              }
              control={
                <span
                  className={
                    status.relay.online
                      ? "text-sm text-success-foreground"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {status.relay.online ? gt("Connected") : gt("Not connected")}
                </span>
              }
            />
          </>
        )}
      </SettingsSection>

      {status === null ? null : (
        <SettingsSection id="relay-devices" title={gt("Relay devices")}>
          {status.devices.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
              <T>
                No devices are paired through the relay. A pairing link made while the relay is on
                pairs the phone that opens it.
              </T>
            </p>
          ) : (
            status.devices.map((device) => (
              <RelayDeviceRow
                key={device.deviceId}
                device={device}
                canRevoke={canRevoke}
                onRevoke={() =>
                  revokeDevice({ environmentId, input: { deviceId: device.deviceId } })
                }
              />
            ))
          )}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function RelayDeviceRow({
  device,
  canRevoke,
  onRevoke,
}: {
  readonly device: RelayHostDevice;
  readonly canRevoke: boolean;
  readonly onRevoke: () => ReturnType<ReturnType<typeof useRelayHostCommands>["revokeDevice"]>;
}) {
  const gt = useGT();
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<{ readonly failed: boolean; readonly text: string } | null>(
    null,
  );
  const name = device.label.length > 0 ? device.label : gt("Unnamed device");
  const seen =
    device.lastConnectedAt === null
      ? gt("Not connected since it was paired")
      : gt("Last connected {time}", { time: formatAccessTimestamp(device.lastConnectedAt) });

  async function revoke() {
    const confirmed = await requestConfirmDialog(
      gt(
        "Revoke {name}?\nThis computer deletes its relay key and closes its connection. It can reach this computer through the relay again only after pairing anew.",
        { name },
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRevoking(true);
    setNotice(null);
    const result = await onRevoke();
    setRevoking(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setNotice({
        failed: true,
        text: error instanceof Error ? error.message : gt("The device was not revoked."),
      });
      return;
    }
    if (result.value.relayFailure !== null) {
      setNotice({
        failed: true,
        text: gt(
          "Its key is deleted here, so it cannot get in, but the relay did not drop it: {error}",
          { error: result.value.relayFailure },
        ),
      });
    }
  }

  return (
    <SettingsRow
      id={`relay-device-${device.deviceId}`}
      title={name}
      description={
        <span className="break-words">
          {gt("Paired {time}", { time: formatAccessTimestamp(device.addedAt) })} · {seen}
          {notice === null ? null : (
            <span
              role={notice.failed ? "alert" : "status"}
              className={notice.failed ? "block text-destructive" : "block"}
            >
              {notice.text}
            </span>
          )}
        </span>
      }
      control={
        canRevoke ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revoking}
            aria-label={gt("Revoke {name}", { name })}
            onClick={() => void revoke()}
          >
            {revoking ? gt("Revoking…") : gt("Revoke")}
          </Button>
        ) : undefined
      }
    />
  );
}
