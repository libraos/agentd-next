import { useAtomValue } from "@effect/atom-react";
import {
  type ConnectionCatalogEntry,
  connectionRoutes,
  isRelayAddressRoute,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { relayHostLabelOfUrl } from "@t3tools/relay-session/route";
import * as Option from "effect/Option";
import { useGT } from "gt-react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { usePreparedConnection } from "../../../state/session";
import { refusedRelayHostsAtom } from "./relayTransport";

/** For an environment this phone can reach through a relay: which way it is connected, or that the relay refused it. */
export function RelayRouteStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly entry: ConnectionCatalogEntry | undefined;
  readonly connected: boolean;
}) {
  const gt = useGT();
  const refused = useAtomValue(refusedRelayHostsAtom);
  const prepared = usePreparedConnection(props.environmentId);
  const relayRoute =
    props.entry === undefined ? undefined : connectionRoutes(props.entry).find(isRelayAddressRoute);
  const relayBaseUrl = relayRoute === undefined ? null : routeHttpBaseUrl(relayRoute);
  const relayLabel = relayBaseUrl === null ? null : relayHostLabelOfUrl(relayBaseUrl);
  if (relayLabel === null) return null;
  if (refused.has(relayLabel)) {
    return (
      <Text className="text-xs text-danger-foreground">
        {gt(
          "{host} no longer lets this phone in through the relay. Pair it again with a new pairing link from {host}.",
          { host: props.hostLabel },
        )}
      </Text>
    );
  }
  if (!props.connected || Option.isNone(prepared)) return null;
  const viaRelay = relayHostLabelOfUrl(prepared.value.httpBaseUrl) !== null;
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
      {viaRelay ? gt("Connected through the relay") : gt("Connected directly")}
    </Text>
  );
}
