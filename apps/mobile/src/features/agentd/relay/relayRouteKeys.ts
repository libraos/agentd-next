import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  readRelayRouteFromUrl,
  relayBaseUrl,
  relayHostLabel,
  relayHostLabelOfUrl,
} from "@t3tools/relay-session/route";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ExpoCrypto from "expo-crypto";
import { msg } from "gt-react-native";

import { m } from "../../../i18n/messages";
import { removeRelayRoute, saveRelayRoute } from "./relayKeyStore";
import { clearRelayRefusal, relayRouter } from "./relayTransport";

export const relayRouteKeys = ClientCapabilities.RelayRouteKeys.of({
  saveFromPairingUrl: Effect.fn("RelayRouteKeys.saveFromPairingUrl")(
    function* (pairingUrl, pairingCode) {
      const route = readRelayRouteFromUrl(pairingUrl);
      const label = route === null ? null : relayHostLabel(route.hostId);
      if (route === null || label === null) return Option.none<string>();
      // A new link brings a new device token and code, so the key is made fresh with them.
      const deviceSecretKey = ExpoCrypto.getRandomBytes(32);
      yield* Effect.tryPromise({
        try: () => saveRelayRoute(label, { route, deviceSecretKey, pairingCode }),
        catch: () =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: m(msg("Could not save the relay keys to the keychain.")),
          }),
      });
      relayRouter.forget(label);
      clearRelayRefusal(label);
      return Option.some(relayBaseUrl(route));
    },
  ),
  remove: Effect.fn("RelayRouteKeys.remove")(function* (httpBaseUrl) {
    const label = relayHostLabelOfUrl(httpBaseUrl);
    if (label === null) return;
    relayRouter.forget(label);
    yield* Effect.promise(() => removeRelayRoute(label).catch(() => undefined));
  }),
});
