# 142: Sort the inherited operations and internals docs

`docs/operations` and `docs/internals` came with upstream. Each page is in one class:

- **applies**: describes LibraOS Next. Only the product name, paths and commands were fixed; `T3CODE_*`
  names, the `t3` command, lint rule names (`t3code/…`) and the glossary term "T3 home" stay.
- **upstream-only**: kept unchanged for clean merges, with one line at the top saying it describes
  upstream T3 Code. Still listed in `docs/README.md`.
- **misleading**: upstream's hosted services or release process. Same top line, and dropped from
  `docs/README.md`'s index.

In a sync, an upstream page new to these folders needs a row here; `scripts/agentd-docs-sorting.test.ts`
fails until it has one. Take upstream's version of an upstream-only or misleading page and keep its
top line.

| Page                                               | Class         |
| -------------------------------------------------- | ------------- |
| `docs/operations/android-notifications.md`         | upstream-only |
| `docs/operations/background-verification.md`       | applies       |
| `docs/operations/connect-setup.md`                 | misleading    |
| `docs/operations/development.md`                   | applies       |
| `docs/operations/mobile-app-store-screenshots.md`  | misleading    |
| `docs/operations/mobile-screens-fork.md`           | upstream-only |
| `docs/operations/observability.md`                 | upstream-only |
| `docs/operations/relay-observability.md`           | misleading    |
| `docs/operations/release.md`                       | misleading    |
| `docs/operations/scenarios.md`                     | applies       |
| `docs/internals/adding-a-provider.md`              | applies       |
| `docs/internals/assistant-citations.md`            | applies       |
| `docs/internals/composer-context-references.md`    | applies       |
| `docs/internals/composer-editors.md`               | applies       |
| `docs/internals/connection-runtime.md`             | applies       |
| `docs/internals/consistency-action-names.md`       | applies       |
| `docs/internals/context-handoffs.md`               | applies       |
| `docs/internals/devcontainer.md`                   | applies       |
| `docs/internals/devices.md`                        | applies       |
| `docs/internals/effect-services.md`                | applies       |
| `docs/internals/environment-auth.md`               | applies       |
| `docs/internals/glossary.md`                       | applies       |
| `docs/internals/i18n.md`                           | applies       |
| `docs/internals/legacy-orchestration-migration.md` | applies       |
| `docs/internals/linux-snap-shot.md`                | applies       |
| `docs/internals/mobile-development.md`             | upstream-only |
| `docs/internals/mobile-layout.md`                  | upstream-only |
| `docs/internals/mobile-navigation.md`              | upstream-only |
| `docs/internals/model-manifest.md`                 | applies       |
| `docs/internals/open-source-licenses.md`           | applies       |
| `docs/internals/overview.md`                       | applies       |
| `docs/internals/performance-regressions.md`        | applies       |
| `docs/internals/product-analytics.md`              | applies       |
| `docs/internals/providers.md`                      | applies       |
| `docs/internals/pull-request-file-revisions.md`    | applies       |
| `docs/internals/remote.md`                         | applies       |
| `docs/internals/resource-telemetry.md`             | applies       |
| `docs/internals/server-updates.md`                 | applies       |
| `docs/internals/t3-connect.md`                     | misleading    |
| `docs/internals/terminal-runtime.md`               | applies       |
| `docs/internals/testing.md`                        | applies       |
| `docs/internals/voice-input.md`                    | applies       |
| `docs/internals/web-ui.md`                         | applies       |

Why some pages are where they are:

- Mobile pages are upstream-only: our builds ship no mobile app (patch 66), but the code is kept.
- `observability.md` describes tracing this code has, with upstream's `~/.t3` paths; its top line
  names our data folder instead of rewriting 700 lines.
- `remote.md`, `environment-auth.md`, `connection-runtime.md` and `devices.md` mention T3 Connect as
  one of the code's connection modes. That is accurate (the relay is off, patch 85), so they apply.
- `development.md`: the forge mirror section says we have none, and the shared dev home is
  `~/.agentd-desktop`. The dev runner still treats only `~/.t3` as a live home to avoid; the page
  says never to pass `~/.agentd-desktop`.

## Upstream files changed

- `docs/README.md`: titled for LibraOS Next; the five misleading pages are out of the index; one
  sentence points here.
- The eleven upstream-only and misleading pages above: one line added under the title.
- `docs/operations/development.md`, `scenarios.md`, `docs/internals/composer-context-references.md`,
  `devcontainer.md`, `environment-auth.md`, `glossary.md`, `i18n.md`, `linux-snap-shot.md`,
  `overview.md`, `providers.md`, `voice-input.md`: product name, clone URL and data folder paths.

Ours: `scripts/agentd-docs-sorting.test.ts` checks this table against the folders, the top lines,
the index, and that no applies page or linked page names T3 Code.
