# 209 — A gateway source whose agent is missing says so

A gateway whose agent is not installed here (Claude Code for an Anthropic-format gateway) used to vanish from the model picker, so its models looked like they came only from the other source. Now the picker lists it beside a model's other sources as "<gateway> · needs <agent>". That choice cannot be picked, and the picker offers an Install action that opens the welcome page's agent install for that computer. It is not run through Pi, and the picker never moves to another source on its own.

A source counts as missing its agent when it is a gateway instance that is turned on and whose last check found no CLI (`installed: false` with status `error`). An agent that has not been checked yet reads `installed: false` with a warning and stays hidden as before. A model only the missing agent offers gets no row of its own; the notice names the source.

## Upstream files changed

- `apps/web/src/components/chat/ModelPickerContent.tsx` — List a gateway source whose agent is missing as a disabled "needs <agent>" source of a shared model, refuse picking it, and show a notice with an Install action.
- `apps/web/src/components/chat/ModelListRow.tsx` — A hover source choice can be disabled, with its reason as the title.
- `apps/web/src/components/chat/ProviderModelPicker.browser.test.tsx` — A gateway source with no Claude Code shows as needing it, cannot be picked, and Install opens the welcome page.
- `apps/web/src/i18n/translations/*.json` (all ten locales) — The "needs <agent>", notice and "(not installed)" strings.
- `docs/user/welcome-page.md` — A gateway's source needs its agent installed; the picker says so and offers Install.

Ours: `apps/web/src/components/onboarding/CustomGatewayList.tsx` — "Used by" marks an agent that is not installed.
