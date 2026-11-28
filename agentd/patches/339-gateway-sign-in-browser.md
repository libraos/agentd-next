# 339 — LibraOS Gateway sign-in leads to the browser (#339)

Connecting the LibraOS Gateway reads as one step: the browser opens (desktop) or one button opens it (web), the person signs in and clicks Approve. The device code is shown only to check against the page. A second Connect while a sign-in waits keeps its code, so the page already open stays valid.

Ours (no upstream counterpart):

- `apps/server/src/gateway/LibraosGateway.ts` (+ test) — `signInStart` returns the waiting sign-in of the same purpose instead of replacing it.

Upstream files changed:

- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — The waiting view: one line of what to do, a Continue in browser / Open LibraOS again button, the code as a check.
- `apps/web/src/i18n/translations/*.json` — The waiting view's strings in every locale.
