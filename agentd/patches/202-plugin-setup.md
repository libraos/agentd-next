# 202 — A plugin's setup step runs from the app

A plugin's `agentd-plugin.json` may declare `setup: { command, description }`: an argv resolved like a hook's (a file in the plugin's folder or a program on PATH) and one sentence on what it downloads and how much disk it needs. After install, Settings → Plugins shows such a plugin as Needs setup, with that sentence and a Set up button. The server runs the command in the background in the plugin's folder with the environment a hook gets (the server's own; no extra variables), with an empty, closed stdin, so it never sees a message. The listing carries the last line it printed while it runs (the page polls every 2 s only while a setup runs), then how it ended. Exit 0 records the install as ready in `<stateDir>/plugins/setup/<id>.json`, keyed by version and commit, so a new version or commit needs setup again; anything else records failed with a reason (the last line of its stderr, else stdout). Set up again repairs. The run is forked into the service's scope, so a closed tab or a dropped phone connection does not stop it; a server restart mid-run leaves it needing setup.

A plugin whose installed manifest declares setup cannot be turned on, for the environment or a project, until its setup succeeded. One turned on before it declared setup stops sends with a reason that points at Settings (hooks stay fail-closed). A plugin without `setup`, and every install from before this change, reads as not needing setup and installs, enables and runs as before. Install and remove are refused while that plugin's setup runs. Removing a plugin that declares setup asks whether to keep or delete its data folder, `<stateDir>/plugins/data/<id>/`; deleting removes only that folder.

Time limit: 60 minutes. The redaction plugin's setup downloads about 2 GB (58 s measured on a fast line); 60 minutes covers that at about 5 Mbit/s with pip's install time. A slower line times out with a reason that says to set up again, and setup_env.py keeps the environment and each model file it already finished and checked, so the next run continues from there. A hook's 60 s ceiling is unchanged.

Ours (no upstream counterpart):

- `packages/contracts/src/agentdPlugins.ts`: the listing's `setup` (description, status, progress, reason), the remove input's `deleteData`, the `setup` error reason.
- `apps/server/src/agentd/pluginCatalog.ts` (covered by `AgentdPlugins.test.ts`): the manifest's `setup`, the setup record and when it counts.
- `apps/server/src/agentd/AgentdPlugins.ts` (+ test): running setup, its state in the listing, the enable gate, the send gate, remove with the data folder.
- `apps/server/src/agentd/redactPlugin.test.ts`: the redaction manifest declares setup.
- `agentd/plugins/redact/agentd-plugin.json`, `setup_env.py`, `redact.py`, `README.md`: declare setup; setup prints one flushed `Step N of 4: …` line per step and download percentages on stdout and sends pip's output to stderr; the block reason points at Set up again.
- `packages/client-runtime/src/state/agentd.ts`, `apps/web/src/lib/agentdState.ts`: the setup command.
- `apps/web/src/components/agentd/AgentdPagePlugins.tsx`: Needs setup, Setting up, Setup failed and Ready badges, the sentence, progress, the reason, Set up / Set up again, and the remove dialog.

Upstream files:

- `packages/contracts/src/rpc.ts`: the `agentd.pluginsSetup` RPC; remove takes the new input.
- `packages/contracts/src/clientRpcPermissions.ts`: setup needs environment maintain, as install does.
- `apps/server/src/observability/RpcInstrumentation.ts`: the setup method counts as `agentd`.
- `apps/server/src/ws.ts`: the setup handler.
- `apps/web/src/i18n/translations/*.json`: the new text in every locale.

Not done: `libraos/plugins` needs `setup` added to `plugins/redact/agentd-plugin.json` and a new catalogue entry (new commit sha) before installed copies get it. Mobile does not list plugins, so it has no setup state or button yet. A setup's child processes are stopped with it on timeout only as far as the process runner stops a process tree.
