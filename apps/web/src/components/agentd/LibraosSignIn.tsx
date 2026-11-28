import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useEffect, useEffectEvent, useId, type ReactNode } from "react";

import { openLibraosSignInPage, useLibraosSignIn } from "../../lib/libraosGatewayState";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const focusOnMount = (node: HTMLElement | null) => node?.focus({ preventScroll: true });

/**
 * While a LibraOS sign-in runs, the page shows only its waiting view in place of `children`: the
 * code to check, Open LibraOS again and Cancel. Once approved it calls `onFinished`.
 */
export function LibraosSignInGate({
  environmentId,
  onFinished,
  children,
}: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly onFinished: () => void;
  readonly children: ReactNode;
}) {
  const signIn = useLibraosSignIn(environmentId);
  if (signIn.view === null) return children;
  return <LibraosSignInView signIn={signIn} onFinished={onFinished} />;
}

function LibraosSignInView({
  signIn,
  onFinished,
}: {
  readonly signIn: ReturnType<typeof useLibraosSignIn>;
  readonly onFinished: () => void;
}) {
  const gt = useGT();
  const headingId = useId();
  const view = signIn.view;
  const desktop = typeof window !== "undefined" && window.desktopBridge !== undefined;

  const handBack = useEffectEvent(() => {
    toastManager.add({ type: "success", title: gt("Signed in to LibraOS") });
    signIn.finish();
    onFinished();
  });
  const follow = useEffectEvent(() => {
    if (view?.kind === "waiting" && !view.opened) signIn.follow(view.signIn);
  });
  const kind = view?.kind ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the sign-in is approved in the browser; the view follows the server's wait and hands back once it answers
  useEffect(() => {
    if (kind === "done") handBack();
    else if (kind === "waiting") follow();
  }, [kind]);

  if (view === null) return null;
  const status =
    view.kind === "starting" ? (
      <T>Opening LibraOS in your browser…</T>
    ) : view.kind === "waiting" ? (
      view.opened ? (
        <T>LibraOS is open in your browser. Sign in there and click Approve.</T>
      ) : (
        <T>Continue in your browser: sign in to LibraOS and click Approve.</T>
      )
    ) : view.kind === "done" ? (
      <T>Signed in to LibraOS</T>
    ) : null;

  return (
    <section
      ref={focusOnMount}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-xl space-y-5 outline-none"
    >
      <h1
        id={headingId}
        className="text-center text-3xl font-semibold tracking-tight text-foreground"
      >
        <T>Sign in to LibraOS</T>
      </h1>
      <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <div role="status" aria-live="polite" className="space-y-3">
          {status === null ? null : <p className="text-foreground">{status}</p>}
          {view.kind === "waiting" ? (
            <p className="text-muted-foreground">
              <T>Waiting for approval…</T>
            </p>
          ) : null}
        </div>
        {view.kind === "waiting" ? (
          <p className="text-muted-foreground">
            <T>
              Check that the page shows{" "}
              <span className="font-mono font-semibold text-foreground">
                <Var>{view.signIn.userCode}</Var>
              </span>
              . No account yet? You can create one there.
            </T>
          </p>
        ) : null}
        {view.kind === "failed" ? (
          <p role="alert" className="text-destructive-foreground">
            {view.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {view.kind === "waiting" ? (
            <Button
              size="sm"
              onClick={() => openLibraosSignInPage(view.signIn.verificationUriComplete)}
            >
              {view.opened || desktop ? <T>Open LibraOS again</T> : <T>Continue in browser</T>}
            </Button>
          ) : null}
          {view.kind === "failed" ? (
            <Button size="sm" disabled={!signIn.canChange} onClick={() => void signIn.start()}>
              {view.hadCode ? <T>Get a new code</T> : <T>Try again</T>}
            </Button>
          ) : null}
          {view.kind === "done" ? null : (
            <Button variant="outline" size="sm" onClick={() => void signIn.cancel()}>
              <T>Cancel</T>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
