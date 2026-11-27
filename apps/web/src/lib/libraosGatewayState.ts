import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationReadScope, WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { useGT, useMessages } from "gt-react";
import { useContext, useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { readLocalApi } from "../localApi";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { isLibraosGatewayUsable, libraosGatewayAgentsChecked } from "./libraosGatewayState.logic";

// The LibraOS Gateway on one environment. The server keeps the key; clients learn only whether it
// is connected and which models it may use.

const scheduler = createAtomCommandScheduler();

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:libraos-gateway:status",
  tag: WS_METHODS.libraosGatewayStatus,
  staleTimeMs: 60_000,
});

const gatewayAgentsChecked = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    libraosGatewayAgentsChecked(get(serverEnvironment.providersValueAtom(environmentId))),
  ).pipe(Atom.withLabel(`environment-data:libraos-gateway:agents-checked:${environmentId}`)),
);

// A provider refresh can find the key refused or its models changed; the card and the picker
// must not disagree until the status goes stale.
const liveStatus = Atom.family((environmentId: EnvironmentId) => {
  const query = status({ environmentId, input: {} });
  return Atom.make((get) => {
    get.subscribe(gatewayAgentsChecked(environmentId), () => get.refresh(query));
    return get(query);
  }).pipe(Atom.withLabel(`environment-data:libraos-gateway:live-status:${environmentId}`));
});

// Console's balance for the connected key. No timer: it is read again when the window regains
// focus, which is also when someone comes back from paying in the browser.
const credits = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:libraos-gateway:credits",
  tag: WS_METHODS.libraosGatewayCredits,
  staleTimeMs: 60_000,
});

// One listener per environment however many views show the balance, and one read per few seconds
// at most: moving between windows fires focus often.
const FOCUS_REFRESH_FLOOR_MS = 5_000;
const focusWatchers = new Map<EnvironmentId, { count: number; readonly stop: () => void }>();

function watchFocus(environmentId: EnvironmentId, refresh: () => void): () => void {
  let watcher = focusWatchers.get(environmentId);
  if (watcher === undefined) {
    let readAt = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - readAt < FOCUS_REFRESH_FLOOR_MS) return;
      readAt = now;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    watcher = { count: 0, stop: () => window.removeEventListener("focus", onFocus) };
    focusWatchers.set(environmentId, watcher);
  }
  watcher.count += 1;
  const current = watcher;
  return () => {
    current.count -= 1;
    if (current.count > 0) return;
    current.stop();
    focusWatchers.delete(environmentId);
  };
}

const refreshStatus = (
  target: { readonly environmentId: EnvironmentId },
  registry: { readonly refresh: <A>(atom: Atom.Atom<A>) => void },
) =>
  Effect.sync(() => {
    registry.refresh(status({ environmentId: target.environmentId, input: {} }));
    registry.refresh(credits({ environmentId: target.environmentId, input: {} }));
  });

const libraosGatewayEnvironment = {
  status,
  connect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:connect",
    tag: WS_METHODS.libraosGatewayConnect,
    scheduler,
    onSettled: refreshStatus,
  }),
  disconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:disconnect",
    tag: WS_METHODS.libraosGatewayDisconnect,
    scheduler,
    onSettled: refreshStatus,
  }),
  signInStart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:sign-in-start",
    tag: WS_METHODS.libraosGatewaySignInStart,
    scheduler,
    onSettled: refreshStatus,
  }),
  // Not on the scheduler: it stays open until the sign-in ends, and Cancel must not queue behind it.
  signInWait: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:sign-in-wait",
    tag: WS_METHODS.libraosGatewaySignInWait,
    onSettled: refreshStatus,
  }),
  signInCancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:sign-in-cancel",
    tag: WS_METHODS.libraosGatewaySignInCancel,
    onSettled: refreshStatus,
  }),
  checkout: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:checkout",
    tag: WS_METHODS.libraosGatewayCheckout,
  }),
};

/** The environment gateways are set up on: `target`, else the primary one; null if unreadable. */
export function useGatewayEnvironment(
  target: EnvironmentId | null | undefined,
): EnvironmentId | null {
  const primary = usePrimaryEnvironment();
  const environmentId = target === undefined ? (primary?.environmentId ?? null) : target;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? environmentId : null;
}

/** The environment the Gateway is set up on (the primary one unless named) and its status. */
export function useLibraosGateway(target?: EnvironmentId | null) {
  const environmentId = useGatewayEnvironment(target);
  const query = useEnvironmentQuery(
    environmentId === null ? null : liveStatus(environmentId),
    useMessages(),
  );
  return { environmentId, ...query };
}

/**
 * Whether agentd can price a `$` budget here: the Gateway is connected on this environment and
 * serves its key.
 * @public for the Hand to a worker dialog (#78).
 */
export function useLibraosGatewayConnected(target?: EnvironmentId | null): boolean {
  return isLibraosGatewayUsable(useLibraosGateway(target).data);
}

export function useLibraosGatewayCommands(environmentId: EnvironmentId | null) {
  const canChange = useAtomValue(
    libraosGatewayEnvironment.connect.permissionAtom(environmentId ?? null),
  );
  // The panel says what failed itself, beside the key field.
  const options = { reportFailure: false } as const;
  return {
    canChange,
    connect: useAtomCommand(libraosGatewayEnvironment.connect, options),
    disconnect: useAtomCommand(libraosGatewayEnvironment.disconnect, options),
    signInStart: useAtomCommand(libraosGatewayEnvironment.signInStart, options),
    signInWait: useAtomCommand(libraosGatewayEnvironment.signInWait, options),
    signInCancel: useAtomCommand(libraosGatewayEnvironment.signInCancel, options),
  };
}

/**
 * The connected key's balance (null data while none is connected, or Console has no balance to
 * give), read again when the window regains focus; never on a timer.
 */
export function useLibraosCredits(target?: EnvironmentId | null) {
  const gateway = useLibraosGateway(target);
  const environmentId = gateway.environmentId;
  const connected = gateway.data?.connected === true;
  const registry = useContext(RegistryContext);
  const query = useEnvironmentQuery(
    connected && environmentId !== null ? credits({ environmentId, input: {} }) : null,
    useMessages(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the balance again when the window regains focus, as when someone comes back from paying in the browser
  useEffect(() => {
    if (!connected || environmentId === null) return;
    return watchFocus(environmentId, () => registry.refresh(credits({ environmentId, input: {} })));
  }, [connected, environmentId, registry]);
  return { environmentId, connected, ...query };
}

/**
 * Starts a Stripe Checkout for one of Console's amounts and opens it in the browser. `opened` is
 * the page once it is open; the person pays there, never in the app.
 */
export function useBuyLibraosCredits(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const m = useMessages();
  const canBuy = useAtomValue(
    libraosGatewayEnvironment.checkout.permissionAtom(environmentId ?? null),
  );
  const checkout = useAtomCommand(libraosGatewayEnvironment.checkout, { reportFailure: false });
  const [state, setState] = useState<{
    readonly buying: number | null;
    readonly error: string | null;
    readonly opened: string | null;
  }>({ buying: null, error: null, opened: null });

  const buy = async (usd: number) => {
    if (environmentId === null || state.buying !== null) return;
    // A browser blocks a tab opened after an await, so the web build opens it during the click and
    // sends it to the checkout once Console answers. The desktop opens the system browser itself.
    const desktop = typeof window !== "undefined" && window.desktopBridge !== undefined;
    const tab = desktop ? null : window.open("", "_blank");
    if (tab !== null) tab.opener = null;
    setState({ buying: usd, error: null, opened: null });
    const result = await checkout({ environmentId, input: { usd } });
    if (result._tag === "Failure") {
      tab?.close();
      setState({
        buying: null,
        opened: null,
        error:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ||
          gt("Could not reach this environment."),
      });
      return;
    }
    const url = result.value.url;
    if (tab !== null) tab.location.href = url;
    else if (desktop)
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch(() => undefined);
    setState({ buying: null, error: null, opened: url });
  };

  return { canBuy, buy, ...state };
}
