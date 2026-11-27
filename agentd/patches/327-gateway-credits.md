# 327 — LibraOS Gateway credits (#327)

With the LibraOS Gateway connected, the balance shows in the Gateway panel, Settings → Providers and
the Usage page. **Buy credits** offers Console's amounts and opens Stripe Checkout in the browser;
the balance refreshes on window focus (no polling). A Gateway turn refused with 402
`insufficient_credits` shows a card with Buy credits and Retry instead of the generic error banner.
Console contract: `GET /v1/credits` and `POST /v1/credits/checkout` on `LIBRAOS_CLOUD_ORIGIN`,
authorised by the connected `lk_` key.

Ours (no upstream counterpart):

- `packages/contracts/src/libraosGateway.ts` (+ test) — Credits and checkout schemas, `LIBRAOS_CREDITS_URL`, `libraosCreditsRefusal` (the 402 / plan-limit matcher shared by client and server).
- `apps/server/src/gateway/gatewayCredits.ts` — Reads Console's answers: 404/501 mean no balance, checkout 404/503 fall back to the Credits page, checkout URLs must be https.
- `apps/server/src/gateway/LibraosGateway.ts` (+ test) — `credits` and `checkout` on the service, with the connected key.
- `apps/server/src/gateway/deviceSignIn.ts` — `cloudRefusal` also reads Console's nested `error.message`.
- `apps/web/src/lib/libraosGatewayState.ts` — Credits query, focus refresh, checkout command; opens the checkout tab during the click so browsers do not block it.
- `apps/web/src/components/agentd/LibraosCredits.tsx` (+ browser test), `libraosCredits.logic.ts` (+ test) — Balance panel, Buy credits button, Usage row, Settings card.
- `apps/web/src/components/agentd/LibraosCreditsThreadError.tsx` (+ browser test) — The out-of-credits card.
- `apps/web/src/components/agentd/StartTaskCloud.tsx`, `taskPlan.tsx` — Cloud Workers' "not enough LibraOS credit" offers Buy credits.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — The connected Gateway panel shows the balance.

Upstream files changed:

- `packages/contracts/src/rpc.ts` — `libraosGateway.credits` and `libraosGateway.checkout` methods.
- `packages/contracts/src/clientRpcPermissions.ts` — Checkout guarded by environment maintenance; it charges the host's key.
- `apps/server/src/auth/RpcAuthorization.ts` — Credits readable with orchestration read, like Gateway status.
- `apps/server/src/auth/RpcAuthorization.test.ts` — Readers see the balance; only maintainers start a checkout.
- `apps/server/src/observability/RpcInstrumentation.ts` — Both methods counted under `libraosGateway`.
- `apps/server/src/ws.ts` — Route both methods to the Gateway service.
- `apps/server/src/orchestration-v2/Orchestrator.ts` — A manual continuation may resume a failed Gateway run refused for credit, so Retry works.
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` — The manual resume test covers an out-of-credits Gateway run.
- `packages/client-runtime/src/state/threadExecution.ts` — `deriveResumableRunId` offers that run for resume (agents without native resume still cannot).
- `packages/client-runtime/src/state/threadExecution.test.ts` — Only a Gateway out-of-credits failure becomes resumable.
- `apps/web/src/components/chat/ChatBannerLane.tsx` — Shows the credits card in place of the generic banner for a Gateway credit refusal.
- `apps/web/src/components/ChatView.tsx` — Passes the error's provider instance and the existing resume to the banner lane.
- `apps/web/src/components/usage/UsageLimits.tsx` — Gateway balance row on the Usage page.
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` — Credits card in the Gateways section.
- `apps/web/src/components/settings/settingsSearch.ts` — "LibraOS credits" entry found by "credits".
- `apps/web/src/components/CommandPalette.tsx` — "Buy LibraOS credits" action.
- `apps/web/src/i18n/translations/*.json` — New strings in all 10 locales.
- `docs/user/welcome-page.md` — Sign-in is the default way to connect; buying credits, the US$20 trial, Stripe in the browser, Retry.
- `docs/user/faq.md` — Gateway use is paid from LibraOS credits bought in the browser.

What each Gateway agent's failed turn carries (all pass through `makeProviderFailure`, capped at 4096 characters):

- Claude Code: `API Error: 402 Your LibraOS credits have run out. …`; the CLI drops the type, matched on the message. A 429 becomes Claude's fixed rate-limit text (class `usage_limit`), so `plan_limit_reached` never shows.
- Codex: `unexpected status 402 Payment Required: <body>`; the body keeps type and message. Its 429 becomes a retry-limit error (class `usage_limit`).
- opencode: the Gateway's message only (1.x code `APIError`; 2.x code `provider.quota`). A 429 is retried silently.
- Pi: `402: {"type":"insufficient_credits",…}`, type kept; a 429 shows `plan_limit_reached`. Pi has no native resume, so its card has Buy credits but no Retry.
