# 328 — LibraOS Gateway plans (#328)

With the LibraOS Gateway connected, a **Plans** section sits beside the balance in the Gateway panel,
Settings → Providers and the Usage page: one card per plan Console returns, with its name, price
per interval and summary as Console words them. **Subscribe** (available) opens Stripe Checkout in
the browser, the account's plan shows **Current plan** with **Manage plan** linking Console's
`manage_url`, and **Coming soon** has no button. Plans refresh on window focus (no polling). A
Console without plans (404/501) shows only a **See plans** link to the Credits page. The
out-of-credits and plan-limit card adds **See plans** beside Buy credits when Console has plans.
Console contract: `GET /v1/plans` and `POST /v1/plans/checkout` on `LIBRAOS_CLOUD_ORIGIN`,
authorised by the connected `lk_` key. The app never names or prices a plan itself.

Ours (no upstream counterpart):

- `packages/contracts/src/libraosGateway.ts` — Plan, plans and plan checkout schemas.
- `apps/server/src/gateway/gatewayCredits.ts` — Reads `/v1/plans`: 404/501 mean no plans, unreadable plans are left out, an unknown state shows as unavailable, `manage_url` must be https. A plan checkout reads like a credits checkout (404/503 fall back to the Credits page).
- `apps/server/src/gateway/LibraosGateway.ts` (+ test) — `plans` and `planCheckout` on the service, with the connected key.
- `apps/web/src/lib/libraosGatewayState.ts` — Plans query, focus refresh (one listener per read and environment), plan checkout command; credits and plans share the code that opens the checkout tab during the click.
- `apps/web/src/components/agentd/LibraosPlans.tsx` (+ browser test) — Plans panel, See plans button, Settings card, Usage section.
- `apps/web/src/components/agentd/LibraosCredits.tsx` — Exports its external link for the plans panel.
- `apps/web/src/components/agentd/LibraosCreditsThreadError.tsx` (+ browser test) — See plans beside Buy credits.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — The connected Gateway panel shows the plans.

Upstream files changed:

- `packages/contracts/src/rpc.ts` — `libraosGateway.plans` and `libraosGateway.planCheckout` methods.
- `packages/contracts/src/clientRpcPermissions.ts` — Plan checkout guarded by environment maintenance, like a credits checkout.
- `apps/server/src/auth/RpcAuthorization.ts` — Plans readable with orchestration read, like the balance.
- `apps/server/src/auth/RpcAuthorization.test.ts` — Readers see the plans; only maintainers start a plan checkout.
- `apps/server/src/observability/RpcInstrumentation.ts` — Both methods counted under `libraosGateway`.
- `apps/server/src/ws.ts` — Route both methods to the Gateway service; `libraosGateway` joins the split handler group, as the other group crossed TypeScript's instantiation limit.
- `apps/web/src/components/usage/UsageLimits.tsx` — Plans section under the Gateway balance row.
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` — Plans card after the credits card.
- `apps/web/src/components/settings/settingsSearch.ts` — "LibraOS plans" entry found by "plans".
- `apps/web/src/components/settings/settingsSearch.test.ts` — "plans" finds it; "credits" still finds credits.
- `apps/web/src/components/CommandPalette.tsx` — "See LibraOS plans" action.
- `apps/web/src/i18n/translations/*.json` — New strings in all 10 locales.
- `docs/user/welcome-page.md` — A LibraOS plans section after credits.
- `docs/user/faq.md` — Gateway use can also be paid through a LibraOS plan.

Every Gateway agent (Claude Code, Codex, opencode, Pi) gets the same See plans on its credit
refusal card: the card is chosen by `libraosCreditsRefusal`, unchanged here. Mobile shows neither
credits nor plans yet, as with #327.
