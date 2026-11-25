# #3 No telemetry and no upstream fetches by default

- `apps/server/src/telemetry/AnalyticsService.ts`: dropped the default PostHog key and `ingest.t3.codes` host; analytics is off unless `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST` are both set. `T3CODE_TELEMETRY_ENABLED` and the managed `telemetry` policy still turn it off. Agent feedback reports (#35871) go through the same service, so they send nothing without an endpoint either; their mode defaults to off and the setting is hidden (patch 5).
- `apps/server/src/telemetry/Identify.ts`, `Identify.test.ts`: upstream's code (#272's rule is now upstream's: the install id never comes from agent login files); the test also records file reads and asserts none under the home folder.
- `apps/server/src/provider/ModelManifest.ts`: no hourly fetch from `raw.githubusercontent.com/pingdotgg`; the bundled manifest is used unless `T3CODE_MODEL_MANIFEST_URL` is set.
- `apps/server/src/provider/ModelManifest.test.ts`: fetch tests set the URL; one row asserts no fetch without it.
- `apps/web/src/components/GitHubStarPrompt.tsx`, `GitHubStarPrompt.test.ts`: removed the star prompt (it called the server to check and star `pingdotgg/t3code`).
- `apps/web/src/components/chat/useComposerSend.ts`: removed the call to the star prompt (2 lines). The `checkStarred`/`star` RPCs stay so this patch stays small.
- `apps/web/package.json`, `pnpm-lock.yaml`: dropped `canvas-confetti` and its types, used only by the star prompt (knip fails otherwise).
- `apps/server/src/triage/triagePrompt.ts`: no default upstream repository. `T3CODE_TRIAGE_REPOSITORY` names it; the context file's Repo line says "none configured" otherwise, and the playbook tells the agent to stay local then.
- `.github/triage/PLAYBOOK.md`: kept byte-identical to the playbook in `triagePrompt.ts`, which a test requires (outside Owns; generated from the TS text).
- `apps/server/src/triage/TriageService.ts`: the source clone uses the configured repository and runs no git without one.
- `apps/server/src/triage/triageSession.ts`: passes the configured repository into the context file (1 line plus import; outside Owns, needed because `t3 triage` in `cli/` writes the same file).
- `apps/server/src/triage/TriageService.test.ts`: tests set a repository; one case asserts no git and "none configured" without it.
- `apps/server/src/cloud/publicConfig.ts`: unchanged. Relay tracing resolves to `null` unless URL, dataset and token are all set (build defines in `apps/server/vite.config.ts` default to `""`), so nothing is sent when they are unset. Same for the relay URL and Clerk keys.
- `docs/user/telemetry.md`, `docs/user/faq.md`, `docs/internals/product-analytics.md`, `docs/internals/model-manifest.md`: say analytics and the remote manifest are off unless configured.
- `agentd/design/outbound.md`: new, the outbound endpoints that remain.

Windows: the change adds no file paths, binaries or shell commands. It reads three environment variables (`T3CODE_POSTHOG_*`, `T3CODE_MODEL_MANIFEST_URL`, `T3CODE_TRIAGE_REPOSITORY`) through Effect `Config`, which works the same on Windows. Triage still runs git only through the existing `GitVcsDriver`, and now only when a repository is configured. Verified on Linux only; not run on Windows.
