import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type LibraosGatewayCheckout,
  type LibraosGatewaySignIn,
} from "@t3tools/contracts";
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
import {
  isLibraosGatewayUsable,
  libraosGatewayAgentsChecked,
  type LibraosSignInAttempt,
  libraosSignInView,
} from "./libraosGatewayState.logic";

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

// Console's plans, read again on focus like the balance: someone may come back from subscribing.
const plans = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:libraos-gateway:plans",
  tag: WS_METHODS.libraosGatewayPlans,
  staleTimeMs: 60_000,
});

// One listener per read and environment however many views show it, and one read per few seconds
// at most: moving between windows fires focus often.
const FOCUS_REFRESH_FLOOR_MS = 5_000;
const focusWatchers = new Map<string, { count: number; readonly stop: () => void }>();

function watchFocus(key: string, refresh: () => void): () => void {
  let watcher = focusWatchers.get(key);
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
    focusWatchers.set(key, watcher);
  }
  watcher.count += 1;
  const current = watcher;
  return () => {
    current.count -= 1;
    if (current.count > 0) return;
    current.stop();
    focusWatchers.delete(key);
  };
}

const refreshStatus = (
  target: { readonly environmentId: EnvironmentId },
  registry: { readonly refresh: <A>(atom: Atom.Atom<A>) => void },
) =>
  Effect.sync(() => {
    registry.refresh(status({ environmentId: target.environmentId, input: {} }));
    registry.refresh(credits({ environmentId: target.environmentId, input: {} }));
    registry.refresh(plans({ environmentId: target.environmentId, input: {} }));
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
  planCheckout: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:libraos-gateway:plan-checkout",
    tag: WS_METHODS.libraosGatewayPlanCheckout,
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
    return watchFocus(`credits:${environmentId}`, () =>
      registry.refresh(credits({ environmentId, input: {} })),
    );
  }, [connected, environmentId, registry]);
  return { environmentId, connected, ...query };
}

/**
 * Console's plans for the connected key's account (null data while none is connected, or Console
 * sells none), read again when the window regains focus; never on a timer.
 */
export function useLibraosPlans(target?: EnvironmentId | null) {
  const gateway = useLibraosGateway(target);
  const environmentId = gateway.environmentId;
  const connected = gateway.data?.connected === true;
  const registry = useContext(RegistryContext);
  const query = useEnvironmentQuery(
    connected && environmentId !== null ? plans({ environmentId, input: {} }) : null,
    useMessages(),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the plans again when the window regains focus, as when someone comes back from subscribing in the browser
  useEffect(() => {
    if (!connected || environmentId === null) return;
    return watchFocus(`plans:${environmentId}`, () =>
      registry.refresh(plans({ environmentId, input: {} })),
    );
  }, [connected, environmentId, registry]);
  return { environmentId, connected, ...query };
}

// The sign-in a click started outlives the row or card that started it: the page shows the waiting
// view in their place.
const signInAttempt = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<LibraosSignInAttempt>({ phase: "idle", ended: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:libraos-gateway:sign-in-attempt:${environmentId}`),
  ),
);
const noSignInAttempt = Atom.make<LibraosSignInAttempt>({ phase: "idle", ended: null }).pipe(
  Atom.withLabel("environment-data:libraos-gateway:sign-in-attempt:none"),
);
let lastSignInAttempt = 0;
const nextSignInAttempt = () => ++lastSignInAttempt;
const signInWaits = new Map<EnvironmentId, number>();

const opensBrowserItself = () => typeof window !== "undefined" && Boolean(window.desktopBridge);

/** Opens LibraOS's sign-in page: the desktop's browser, or a new tab from a click on the web. */
export function openLibraosSignInPage(url: string) {
  if (opensBrowserItself()) {
    void readLocalApi()
      ?.shell.openExternal(url)
      .catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * The device sign-in one click starts: the browser opens at LibraOS's approval page at once (a tab
 * opened during the click on the web, which a browser would block after an await), and the page
 * shows `view` until it ends. `view` is null while there is nothing to wait for.
 */
export function useLibraosSignIn(target?: EnvironmentId | null) {
  const gt = useGT();
  const m = useMessages();
  const gateway = useLibraosGateway(target);
  const environmentId = gateway.environmentId;
  const registry = useContext(RegistryContext);
  const { canChange, signInStart, signInWait, signInCancel } =
    useLibraosGatewayCommands(environmentId);
  const attempt = useAtomValue(
    environmentId === null ? noSignInAttempt : signInAttempt(environmentId),
  );
  const pending = gateway.data?.signIn ?? null;
  const view = libraosSignInView(attempt, pending);
  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) =>
    thrownErrorMessage(squashAtomCommandFailure(result), m) ||
    gt("Could not reach this environment.");

  const set = (target: EnvironmentId, next: LibraosSignInAttempt, onlyId?: number) => {
    const atom = signInAttempt(target);
    const current = registry.get(atom);
    // A later click or a Cancel owns the view; an older sign-in's answer leaves it alone.
    if (onlyId !== undefined && (!("id" in current) || current.id !== onlyId)) return;
    registry.set(atom, next);
  };

  const wait = async (target: EnvironmentId, id: number, signIn: LibraosGatewaySignIn) => {
    signInWaits.set(target, (signInWaits.get(target) ?? 0) + 1);
    const result = await signInWait({ environmentId: target, input: {} });
    signInWaits.set(target, (signInWaits.get(target) ?? 1) - 1);
    set(
      target,
      result._tag === "Failure"
        ? { phase: "failed", id, error: failure(result), hadCode: true }
        : { phase: "done", id, ended: signIn.userCode },
      id,
    );
  };

  const start = async () => {
    if (environmentId === null || !canChange) return;
    const desktop = opensBrowserItself();
    const tab = desktop ? null : window.open("", "_blank");
    if (tab !== null) tab.opener = null;
    const id = nextSignInAttempt();
    set(environmentId, { phase: "starting", id });
    const result = await signInStart({ environmentId, input: { purpose: "connect" } });
    if (result._tag === "Failure") {
      tab?.close();
      set(environmentId, { phase: "failed", id, error: failure(result), hadCode: false }, id);
      return;
    }
    const signIn = result.value;
    const now = registry.get(signInAttempt(environmentId));
    if (!("id" in now) || now.id !== id) {
      tab?.close();
      // Cancelled while the code was on its way; a later click's sign-in is left running.
      if (now.phase !== "idle") return;
      set(environmentId, { phase: "idle", ended: signIn.userCode });
      await signInCancel({ environmentId, input: {} });
      return;
    }
    if (tab !== null) tab.location.href = signIn.verificationUriComplete;
    else if (desktop) openLibraosSignInPage(signIn.verificationUriComplete);
    set(environmentId, { phase: "waiting", id, signIn, opened: tab !== null || desktop }, id);
    void wait(environmentId, id, signIn);
  };

  /** Follows a sign-in the server is already running, as after a reload. */
  const follow = (signIn: LibraosGatewaySignIn) => {
    if (environmentId === null || (signInWaits.get(environmentId) ?? 0) > 0) return;
    const id = nextSignInAttempt();
    set(environmentId, { phase: "waiting", id, signIn, opened: false });
    void wait(environmentId, id, signIn);
  };

  const cancel = async () => {
    if (environmentId === null) return;
    const ended = view?.kind === "waiting" ? view.signIn.userCode : null;
    set(environmentId, { phase: "idle", ended });
    if (ended === null) return;
    await signInCancel({ environmentId, input: {} });
  };

  /** The view handed back to its page; the page may now move focus on. */
  const finish = () => {
    if (environmentId === null || attempt.phase !== "done") return;
    set(environmentId, { phase: "signedIn", ended: attempt.ended });
  };

  return {
    environmentId,
    canChange,
    view,
    signedIn: attempt.phase === "signedIn",
    start,
    follow,
    cancel,
    finish,
  };
}

/**
 * Opens the Stripe Checkout `start` answers with in the browser: the page once open, or what went
 * wrong. A browser blocks a tab opened after an await, so the web build opens it during the click
 * and sends it to the checkout once Console answers. The desktop opens the system browser itself.
 */
async function openCheckout(
  start: () => Promise<AtomCommandResult<LibraosGatewayCheckout, unknown>>,
  failed: (cause: unknown) => string,
): Promise<{ readonly opened: string } | { readonly error: string }> {
  const desktop = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const tab = desktop ? null : window.open("", "_blank");
  if (tab !== null) tab.opener = null;
  const result = await start();
  if (result._tag === "Failure") {
    tab?.close();
    return { error: failed(squashAtomCommandFailure(result)) };
  }
  const url = result.value.url;
  if (tab !== null) tab.location.href = url;
  else if (desktop)
    await readLocalApi()
      ?.shell.openExternal(url)
      .catch(() => undefined);
  return { opened: url };
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
  const failed = (cause: unknown) =>
    thrownErrorMessage(cause, m) || gt("Could not reach this environment.");

  const buy = async (usd: number) => {
    if (environmentId === null || state.buying !== null) return;
    const start = () => checkout({ environmentId, input: { usd } });
    const pending = openCheckout(start, failed);
    setState({ buying: usd, error: null, opened: null });
    const outcome = await pending;
    setState({ buying: null, error: null, opened: null, ...outcome });
  };

  return { canBuy, buy, ...state };
}

/**
 * Starts a Stripe Checkout for one of Console's plans and opens it in the browser. `opened` is the
 * page once it is open; the person subscribes there, never in the app.
 */
export function useSubscribeLibraosPlan(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const m = useMessages();
  const canSubscribe = useAtomValue(
    libraosGatewayEnvironment.planCheckout.permissionAtom(environmentId ?? null),
  );
  const planCheckout = useAtomCommand(libraosGatewayEnvironment.planCheckout, {
    reportFailure: false,
  });
  const [state, setState] = useState<{
    readonly subscribing: string | null;
    readonly error: string | null;
    readonly opened: string | null;
  }>({ subscribing: null, error: null, opened: null });
  const failed = (cause: unknown) =>
    thrownErrorMessage(cause, m) || gt("Could not reach this environment.");

  const subscribe = async (plan: string) => {
    if (environmentId === null || state.subscribing !== null) return;
    const start = () => planCheckout({ environmentId, input: { plan } });
    const pending = openCheckout(start, failed);
    setState({ subscribing: plan, error: null, opened: null });
    const outcome = await pending;
    setState({ subscribing: null, error: null, opened: null, ...outcome });
  };

  return { canSubscribe, subscribe, ...state };
}
