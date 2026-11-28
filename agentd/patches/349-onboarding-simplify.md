# 349 — Simpler welcome page, shorter Gateway agent names, compact LibraOS card

The welcome page is back to upstream's shape with our name: **Welcome to LibraOS Next**, the agent list, Continue. The two account cards are gone; a **LibraOS** row heads the agent list (Sign in, or the balance and Manage once connected), and the footer keeps only **Use an API key or custom gateway**. **Join a team** stays in the Settings sidebar. The built-in Gateway's agents are named `<Agent> · LibraOS`; agents still carrying the old `· LibraOS Gateway` default are renamed once per state directory, and a name the person changed is left alone. A custom gateway saved without a name is named after its URL's host. Settings → Providers shows one compact LibraOS card (balance and plan, **Buy credits** and **Plans** in popovers, or **Sign in**) above **Your gateways**. No free trial is promised.

- `apps/web/src/components/onboarding/WelcomePage.tsx`: title "Welcome to LibraOS Next"; the account cards and the "Agents that are on…" line (ours, not upstream's) removed; `AgentsSection` takes a `leading` row, used for the LibraOS row; footer is one link, Join a team removed.
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx`: expects the LibraOS row first, the new title and footer link, and no Join a team link.
- `apps/web/src/onboarding/welcomePage.logic.test.ts`: a ready Gateway Pi with no other agent installed counts as ready, so Continue is enabled.
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx`: the LibraOS card replaces the credits and plans cards; the section is headed "Your gateways"; `setupEndpoint: "gateway"` opens the connect screen with LibraOS Gateway chosen.
- `apps/web/src/routes/_chat.settings.providers.tsx`: accepts `setupEndpoint=gateway` and passes `setupEndpoint` through.
- `apps/web/package.json`: `i18n:check` runs the repository's catalog check from `apps/web`, as AGENTS.md describes.
- `apps/web/src/i18n/translations/*.json` (10 locales): regenerated; every new string translated.
- `docs/user/welcome-page.md`: the new page and names, Join a team in Settings, no trial.
- `docs/user/faq.md`: where to sign in to LibraOS now.
