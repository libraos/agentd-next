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

| Page                                           | Class         |
| ---------------------------------------------- | ------------- |
| `docs/operations/00_development.md`            | applies       |
| `docs/operations/01_devcontainer.md`           | applies       |
| `docs/operations/02_connect-setup.md`          | misleading    |
| `docs/operations/03_release.md`                | misleading    |
| `docs/operations/04_observability.md`          | upstream-only |
| `docs/operations/05_relay-observability.md`    | misleading    |
| `docs/internals/00_glossary.md`                | applies       |
| `docs/internals/01_architecture.md`            | applies       |
| `docs/internals/02_effect-services.md`         | applies       |
| `docs/internals/03_providers.md`               | applies       |
| `docs/internals/04_environment-auth.md`        | applies       |
| `docs/internals/05_remote.md`                  | applies       |
| `docs/internals/06_t3-connect.md`              | misleading    |
| `docs/internals/07_server-updates.md`          | applies       |
| `docs/internals/08_product-analytics.md`       | applies       |
| `docs/internals/09_connection-runtime.md`      | applies       |
| `docs/internals/10_web-ui.md`                  | applies       |
| `docs/internals/11_mobile-layout.md`           | upstream-only |
| `docs/internals/12_mobile-navigation.md`       | upstream-only |
| `docs/internals/13_mobile-development.md`      | upstream-only |
| `docs/internals/14_i18n.md`                    | applies       |
| `docs/internals/15_testing.md`                 | applies       |
| `docs/internals/16_performance-regressions.md` | applies       |
| `docs/internals/17_scripts.md`                 | applies       |
| `docs/internals/adding-a-provider.md`          | applies       |

Why some pages are where they are:

- Mobile pages are upstream-only: our builds ship no mobile app (patch 66), but the code is kept.
- `04_observability.md` describes tracing this code has, with upstream's `~/.t3` paths; its top line
  names our data folder instead of rewriting 700 lines.
- `05_remote.md`, `04_environment-auth.md` and `09_connection-runtime.md` mention T3 Connect as
  one of the code's connection modes. That is accurate (the relay is off, patch 85), so they apply.
- `00_development.md`: the forge mirror section says we have none, and the shared dev home is
  `~/.agentd-desktop`. The dev runner still treats only `~/.t3` as a live home to avoid; the page
  says never to pass `~/.agentd-desktop`.

## Upstream files changed

- `docs/README.md`: titled for LibraOS Next; the four misleading pages are out of the index; one
  sentence points here.
- The seven upstream-only and misleading pages above: one line added under the title.
- `docs/operations/00_development.md`, `docs/internals/00_glossary.md`, `01_architecture.md`,
  `08_product-analytics.md` (also: no analytics unless an endpoint is configured), and the other
  applies pages: product name, clone URL and data folder paths.

Upstream renumbered these folders on 2026-11-25 and folded several pages into others; the table
was rewritten for the new names then.
