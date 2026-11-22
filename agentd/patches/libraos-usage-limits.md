# LibraOS account in usage limits

The Usage page's Limits view shows the LibraOS account beside Codex and Claude: a monthly worker-minutes window for a plan account, and the credit balance as one line of text. The data comes from `agentd cloud balance` through the primary environment's agentd (`agentdCloud.ts`, `useLibraosLimitAccount.ts`), read when the view opens and at most once a minute.

- `packages/contracts/src/providerUsageLimits.ts` — Optional `amountText` on a usage window, the absolute amount left; no existing source sets it.
- `packages/shared/src/usageLimits.ts` — `LimitAccount.creditUsd`, and the LibraOS reading and account builders (`nextLibraosReading`, `libraosLimitAccount`).
- `packages/shared/src/usageLimitsCopy.ts` — The LibraOS window's label and "N of M min left" text.
- `packages/shared/src/usageLimits.test.ts` — Cases for the LibraOS account: plan, no plan, unmeasurable plan, over the allowance, sign-out and failed reads.
- `apps/web/src/components/usage/UsageLimits.tsx` — Pass the LibraOS account to the pooled view; show a window's `amountText` beside its bar.
- `apps/web/src/components/usage/UsageLimitsPooled.tsx` — Accept accounts that are not a provider's, head the LibraOS section with its name, show the credit line and a single account's `amountText`.
- `apps/web/src/i18n/translations/*.json`, `apps/mobile/src/i18n/translations/*.json` — The three new sentences, translated in all nine locales.

The `/usage-limits` composer panel is per provider instance, so it does not list LibraOS; it renders `amountText` should a provider window carry one. No platform-specific code.
