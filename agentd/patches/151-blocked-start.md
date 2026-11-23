# 151 A Start refused by an open task

- `packages/contracts/src/rpc.ts` adds the `agentd.retryStart` method.
- `packages/contracts/src/clientRpcPermissions.ts` guards `agentd.retryStart` like `agentd.startTask`.
- `apps/server/src/ws.ts` serves `agentd.retryStart` from the agentd bridge.
- `apps/server/src/observability/RpcInstrumentation.ts` files `agentd.retryStart` under agentd.
- `apps/web/src/i18n/translations/de.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/en.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/es.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/fr.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/ja.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/ko.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/pt-BR.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/ru.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/sv.json` adds the text naming the task that holds the folder, Release it and Start anyway.
- `apps/web/src/i18n/translations/zh.json` adds the text naming the task that holds the folder, Release it and Start anyway.
