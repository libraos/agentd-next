import type { DeviceSocket } from "@t3tools/relay-session/device";
import { createRelayRouter } from "@t3tools/relay-session/deviceRouter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";
import * as Socket from "effect/socket/Socket";

import { appAtomRegistry } from "../../../state/atom-registry";

// React Native's WebSocket takes handshake headers as a third argument, which the DOM type lacks.
type NativeWebSocketConstructor = new (
  url: string,
  protocols: ReadonlyArray<string>,
  options: { readonly headers: Readonly<Record<string, string>> },
) => DeviceSocket;

/** Relay host labels whose relay or host refused this phone since it last opened a tunnel there. */
export const refusedRelayHostsAtom = Atom.make(new Set<string>() as ReadonlySet<string>).pipe(
  Atom.keepAlive,
);

const setRefused = (label: string, refused: boolean) => {
  const current = appAtomRegistry.get(refusedRelayHostsAtom);
  if (current.has(label) === refused) return;
  const next = new Set(current);
  if (refused) next.add(label);
  else next.delete(label);
  appAtomRegistry.set(refusedRelayHostsAtom, next);
};

export const clearRelayRefusal = (label: string) => setRefused(label, false);

// The app runtime loads this module at startup, possibly while the phone is locked, so the
// keychain and crypto native modules are imported on first use rather than with it.
const keyStore = () => import("./relayKeyStore");

export const relayRouter = createRelayRouter({
  load: async (label) => (await keyStore()).loadRelayRoute(label),
  onPaired: async (label) => (await keyStore()).markRelayRoutePaired(label),
  onOpened: (label) => setRefused(label, false),
  onRefused: (label) => setRefused(label, true),
  connect: (url, protocols, headers) =>
    new (globalThis.WebSocket as unknown as NativeWebSocketConstructor)(url, protocols, {
      headers,
    }),
  randomBytes: async (length) => (await import("expo-crypto")).getRandomBytes(length),
});

/** fetch that carries relay addresses through the relay and everything else as before. */
export const relayAwareFetch = relayRouter.fetch((input, init) => fetch(input, init));

/** Wraps the app's WebSocket constructor so relay addresses go through the relay tunnel. */
export const withRelayWebSockets = <E, R>(
  base: Layer.Layer<Socket.WebSocketConstructor, E, R>,
): Layer.Layer<Socket.WebSocketConstructor, E, R> =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const open = yield* Socket.WebSocketConstructor;
      const route = relayRouter.webSocket<Socket.WebSocketLike>((url, protocols) =>
        open(url, protocols),
      );
      return (url, options) =>
        options !== undefined && typeof options !== "string" && !Array.isArray(options)
          ? open(url, options)
          : route(url, options);
    }),
  ).pipe(Layer.provide(base));
