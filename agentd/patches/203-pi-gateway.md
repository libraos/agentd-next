# 203 — Pi through a connected gateway, shipped with the app

AgentD Next works with only a connected model gateway and Pi, with no Claude Code or Codex installed.

- Every connected OpenAI-format gateway gets a Pi instance beside its Codex and opencode instances: "Pi · LibraOS Gateway" (`libraosPi`) and `gw-<id>-pi` for a custom gateway. Its environment holds the gateway key as a sensitive variable (`LIBRAOS_API_KEY` or `CUSTOM_GATEWAY_API_KEY`) and `PI_CODING_AGENT_DIR=<stateDir>/pi-gateway/<instanceId>`. That directory holds a `models.json` with the gateway as the only provider (`api: openai-completions`, `baseUrl` ending `/v1`, `apiKey: "$<VAR>"`, the key's models) and a `settings.json` whose default model is the gateway's. Connect or add writes it before the instance exists; a model refresh or hidden-model change rewrites it (atomically); disconnect or remove deletes it. `~/.pi` and the user's own `pi` instance are never written.
- The app ships `@earendil-works/pi-coding-agent` 1.6.0. A Pi instance with no binary path set runs `pi` from PATH when there is one, else the shipped CLI script on the server's own runtime (Node, or Electron with `ELECTRON_RUN_AS_NODE=1`).
- First run: connecting a gateway when no default model is chosen yet and no `claude`, `codex` or `opencode` is on PATH makes its Pi instance the default (`model: "default"`, Pi's default, which is the gateway's). Removing that gateway clears a default that still points at its Pi instance.
- An Anthropic-format custom gateway gets no Pi instance yet (Pi's `anthropic-messages` API is untested there).

Ours: `apps/server/src/gateway/gatewaySetup.ts`, `piGatewayAgent.ts` (new), `LibraosGateway.ts`, `CustomGateway.ts` and their tests; `packages/contracts/src/libraosGateway.ts`, `customGateway.ts` (+ new test); `apps/web/src/components/onboarding/CustomGatewayForm.tsx`, `CustomGatewayList.tsx`; `packages/provider-pi/src/server/binary.ts` and its test (new files in an upstream package).

## Upstream files changed

- `AGENTS.md` — The fork rule allows a default agent; the other providers stay equal in features.
- `apps/server/package.json` — Depends on `@earendil-works/pi-coding-agent` 1.6.0, so the server build and the desktop stage carry it.
- `packages/provider-pi/package.json` — The same pinned dependency, so the unbundled dev server finds the shipped Pi.
- `packages/provider-pi/src/server/driver.ts` — Resolves the binary once per instance build (`resolvePiBinaryPath`) and passes it to the adapter, status probe and text generation.
- `packages/provider-pi/src/server/adapter.ts` — Spawns through `piCommandLine`, so a script binary runs on the server's runtime.
- `packages/provider-pi/src/server/status.ts` — The same for the RPC probe, `--version` and `auth check`.
- `packages/provider-pi/src/server/textGeneration.ts` — The same for text generation.
- `apps/web/src/components/chat/ModelPickerContent.tsx` — A gateway's instances show in the picker whatever agent discovery offers (Pi is not one of the three default drivers).
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` — The same for Settings → Providers.
- `scripts/lib/cli-external-packages.ts` — A list of packages the server spawns and never imports, staged into the packaged app beside the import externals.
- `scripts/lib/cli-external-packages.test.ts` — Pi is staged; `effect` is not.
- `pnpm-workspace.yaml` — `allowBuilds: false` for Pi's `@google/genai` (no-op preinstall) and `protobufjs` (version-check postinstall).
- `pnpm-lock.yaml` — The new dependency.
- `third-party-licenses.config.json` — MIT notices for Pi's packages and two of its dependencies, which ship no license file.
- `knip.jsonc` — The Pi dependency is spawned, not imported, in `apps/server` and `packages/provider-pi`.
- `docs/user/welcome-page.md` — Connecting a gateway adds a Pi agent that needs nothing installed, and when it becomes the default.
- `docs/user/faq.md` — With no harness installed, the app runs its shipped Pi through a connected gateway.
