# 117 — Gateway agents list only the models the key allows

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" now list the key's models instead of the agent's whole catalog with the key's models added. A catalog entry the key allows keeps its name and options, a key model the catalog lacks is added as a custom model, the rest is dropped. With none, the agent lists nothing and says why. A provider refresh by a client allowed to manage providers, and each server start, asks the Gateway for the key's list again and changes only the model lists of the Gateway agents still present, in one settings write, so the user's launch arguments, variables and a concurrent edit or removal stay. opencode's inline config keeps everything but the Gateway provider's model list (and a default model the key dropped), and an opencode agent whose key variable was edited gets that key's list. A key the Gateway refuses (401/403) leaves the agents no models and the Gateway card says why, with the Gateway's reason cut to one line, 200 characters and no credentials; an unreachable Gateway leaves the last list. A model the key dropped is not brought back from the previous snapshot or the boot cache. Agents connected before #117 are limited to their list from their first snapshot, before the Gateway answers. The opencode Gateway agent loses custom models added before #117. A client without `providers:manage` is told that a model added to the opencode Gateway agent's key shows after a provider manager's refresh. The Gateway agents' models cannot be edited in Settings; mobile marks a model the key dropped unavailable. Agents on their own login keep their full catalogs. A thread on a Gateway agent set to a model the key no longer allows shows it as unavailable instead of quietly showing another model.

An agent whose own config points at the Gateway (Codex with `model_provider` at api.libraos.com, Claude Code with `ANTHROPIC_BASE_URL` there) lists the models the Gateway allows for the key that agent sends: its status check reads the key from the variable the agent itself reads (Codex's `env_key`; `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` from Claude's settings or environment), asks `https://api.libraos.com/v1/models` with it and nowhere else, and keeps it only in memory, beside the list it last allowed. A refused or missing key lists none; an unreachable Gateway leaves the key's last answer (a refusal stays an empty list), or, before its first answer, the stored list of an in-app Gateway agent only when it still sends the connected key, else none; never the whole catalog. opencode configured by hand with a provider at the Gateway lists only that provider's models the key it sends allows (opencode 1.x; opencode 2 does not report a provider's endpoint or key). Web and desktop show such an agent's list as the server sends it, without saved custom models.

Ours: `apps/server/src/gateway/gatewayKeyModels.ts` (one Gateway model request under one deadline for headers and body, used by the Gateway service and the hand-configured check) and its test. `apps/web/src/lib/libraosGatewayState.logic.ts` and its test: the Gateway card re-reads its status when the Gateway agents are probed again (a provider refresh may have found the key refused), and a refused key does not count as connected for a `$` budget.

## Upstream files changed

- `packages/contracts/src/server.ts` — Optional `auth.endpointProviders`: the sub-providers whose list the key sent to an endpoint decides, for an OpenCode account that mixes the Gateway with other providers.
- `packages/contracts/src/settings.ts` — Hidden `onlyCustomModels` on Codex and Claude settings: the custom models replace the catalog.
- `packages/provider-core/src/server/snapshotProbe.ts` — `providerModelsFromSettings` takes `onlyCustomModels`; `withNoServedModelsNotice` says why such a list is empty; the `EndpointKeyModels` hook type, with the `known` list that stands before the endpoint answers.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — The replace rule and the empty-list notice.
- `apps/server/src/provider/CodexProvider.ts` — Pass `onlyCustomModels` through and add the empty-list notice to the status check; read the route's `env_key` and, for an endpoint that serves only some models for that key, list only those; an in-app Gateway agent too, so a key replaced in its variables decides its list (the stored list stands until the Gateway answers for it). `withRememberedCodexRoute` keeps the last route Codex's config confirmed when a later `config/read` fails.
- `apps/server/src/provider/ClaudeProvider.ts` — The same for Claude, with the key from `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, also when Claude's initialization fails; no update notices when the key decides the list.
- `apps/server/src/provider/CodexProvider.test.ts` — The `env_key` a LibraOS route names.
- `apps/server/src/provider/codexModelCatalog.ts` — No "update Codex" notice for a Gateway agent: its key decides which models it lacks.
- `apps/server/src/provider/codexModelCatalog.test.ts` — That case.
- `apps/server/src/provider/ProviderHostLive.ts` — Gives drivers the hand-configured Gateway check.
- `packages/provider-core/src/server/ProviderHost.ts` — Optional `endpointKeyModels` for a driver that cannot import the server's Gateway code (opencode).
- `packages/provider-opencode/src/server/driver.ts` — Passes the host's Gateway check to the status check and applies it to a project's own opencode.jsonc providers; a project list the Gateway decided is final even when empty.
- `apps/server/src/provider/Drivers/ClaudeSkills.ts` — Claude's settings `env` also yields the two key variables, for that check.
- `apps/server/src/provider/Drivers/CodexDriver.ts` — A Gateway instance without the flag (saved before #117) is limited anyway; the status check asks the Gateway for the key Codex sends, on the route last confirmed when a config read fails.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` — The same for Claude.
- `apps/server/src/provider/Drivers/ClaudeDriver.test.ts` — New: the first snapshot of a pre-#117 Gateway Claude agent lists only its key's models.
- `apps/server/src/provider/ProviderRegistry.ts` — A Gateway instance, or any instance whose endpoint is the Gateway, never keeps models missing from its new snapshot; nor does a sub-provider in `endpointProviders`.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists only the key's models, or none with a warning; a dropped Gateway model is not brought back (also for hand-configured opencode); the OpenCode 2 empty-list message; a hand-configured Gateway Claude whose initialization fails.
- `apps/server/src/provider/providerStatusCache.ts` — The boot cache names a Gateway agent's models but adds none the settings lack.
- `apps/server/src/provider/providerStatusCache.test.ts` — That case.
- `apps/server/src/ws.ts` — A provider refresh with `refreshModels` from a session with `providers:manage` re-reads the key's models before probing the Gateway agents. This puts a settings write in the upstream refresh RPC (read-scoped): when upstream changes refresh semantics or its authorization, carry the scope check forward.
- `apps/server/src/ws.test.ts` — The Gateway mock answers `refreshModels`; only a provider manager's refresh reaches it.
- `apps/server/src/serverSettings.ts` — `updateProviderInstances` rewrites instances from the stored ones within one write.
- `apps/server/src/device/DeviceService.test.ts` — Its settings mock gains `updateProviderInstances`.
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` — Its settings mock gains `updateProviderInstances`.
- `packages/provider-opencode/src/server/status.ts` — An empty model list no longer reads as a discovery delay ("yet"); a key may allow none. A provider at the Gateway lists only the models its key allows, saved custom models on it included; when every connected provider is at the Gateway the status names it as the endpoint, so an empty list is final; in a mixed account it names the Gateway's providers in `endpointProviders`.
- `packages/provider-opencode/src/server/status.test.ts` — The empty-list message; a hand-configured Gateway provider, its custom models, a mixed account and a revoked key.
- `packages/provider-opencode/src/server/driver.test.ts` — A project's own Gateway provider lists only the key's models.
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` — A saved custom model on a sub-provider in `endpointProviders` shows only if the server lists it. No custom models on the Gateway agents or agents configured for the Gateway, which show the server's list; a line says where their models come from, and, on a client without `providers:manage`, that a model added to the opencode Gateway agent's key shows after a manager's refresh.
- `apps/web/src/components/settings/ProviderInstanceCard.test.ts` — The server's list for an agent configured for the Gateway.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — The Gateway's refusal, and what to do then instead of the usual guidance.
- `apps/web/src/modelSelection.ts` — A saved custom model on a sub-provider in `endpointProviders` shows only if the server lists it. A Gateway instance, or one whose endpoint is the Gateway, lists exactly the server's models and keeps a selected model it no longer lists, marked unavailable, as runtime-catalog drivers already do.
- `apps/web/src/modelSelection.test.ts` — A Gateway Codex agent shows a dropped model as unavailable; the agent's own instance does not.
- `apps/mobile/src/lib/modelOptions.ts` — A model the key dropped is unavailable on a Gateway agent, one whose endpoint is the Gateway, or a sub-provider in `endpointProviders`, as on web.
- `apps/mobile/src/lib/modelOptions.test.ts` — That case.
- `apps/mobile/src/state/thread-task-permissions.test.ts` — Its provider fixtures gain the schema-required `auth` the Gateway check reads.
- `apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx` — Refresh providers asks for `refreshModels`, as web does, so a provider manager's refresh asks the Gateway again.
- `apps/web/src/i18n/translations/de.json` — The new web strings.
- `apps/web/src/i18n/translations/en.json` — The new web strings.
- `apps/web/src/i18n/translations/es.json` — The new web strings.
- `apps/web/src/i18n/translations/fr.json` — The new web strings.
- `apps/web/src/i18n/translations/ja.json` — The new web strings.
- `apps/web/src/i18n/translations/ko.json` — The new web strings.
- `apps/web/src/i18n/translations/pt-BR.json` — The new web strings.
- `apps/web/src/i18n/translations/ru.json` — The new web strings.
- `apps/web/src/i18n/translations/sv.json` — The new web strings.
- `apps/web/src/i18n/translations/zh.json` — The new web strings.
- `apps/mobile/src/i18n/translations/de.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/en.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/es.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/fr.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ja.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ko.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/pt-BR.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ru.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/sv.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/zh.json` — The new mobile string.
