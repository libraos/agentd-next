# Sign in with GitHub through our own app

Upstream's GitHub sign-in (device flow) is turned on by a client id, which our builds left unset,
so it was off. The owner registered our own GitHub App: slug `libraos-next`, client id
`Iv23li6cv5OFAEY0qoob`, Device Flow on, installed on selected libraos repositories, no client
secret. The client id is a public identifier; it is the only App value in the code, and Next never
needs the App's private key or a secret.

The id is the default in code rather than set by the release workflows, so every build (desktop,
server, `t3` and dev) signs in with it and no build config or workflow secret carries it. Order:
the `github_app_client_id` flag in `T3CODE_FEATURE_FLAGS` when it is present, even empty; else
`T3CODE_GITHUB_APP_CLIENT_ID` when it is set, even empty; else our app. An empty value turns
sign-in off as an unset one did before. `FeatureFlags.layerTest` keeps sign-in off unless a test
sets an id.

## Upstream files changed

- `packages/shared/src/FeatureFlags.ts`: `LIBRAOS_NEXT_GITHUB_APP_CLIENT_ID` and the order above;
  an explicitly empty flag now counts as set.
- `packages/shared/src/FeatureFlags.test.ts`: the default, an empty flag or variable keeping
  sign-in off, and the variable overriding the default through the layer.
- `packages/source-control-github/src/shared/definition.ts`: the install link goes to
  `apps/libraos-next` instead of upstream's app.
- `packages/source-control-github/src/shared/definition.test.ts`: checks the install link.
- `packages/source-control-github/src/server/GitHubAppSignIn.test.ts`: the no-client-id case also
  runs with an empty id.
- `docs/user/source-control.md`: how sign-in works and who can use it (a libraos member with access
  to the repository).
