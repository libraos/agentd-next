# 13: one CI workflow of our own

**The new `.github/workflows/ci.yml` has not run.** GitHub Actions is off for this repository. I checked
the workflow by parsing it as YAML, by finding each command in the repository (`package.json` scripts,
`apps/desktop` `ensure:electron`, and the playwright CLIs under `apps/web` and `apps/server`), and by
resolving each pinned action SHA to its release tag. It runs on pull requests and pushes to `main`, on
`ubuntu-latest`, with `permissions: contents: read` and no secrets. Its jobs: format (`fmt:check`), lint,
`i18n:check`, typecheck, unit tests (every package except the root), and the `@t3tools/web` build. It
leaves out upstream's Rust, macOS mobile lint, desktop launch, release smoke and transfer-budget jobs, and
upstream's private task cache.

## Changed

- `.github/workflows/ci.yml`: rewritten. Upstream's version ran on Blacksmith runners and read the
  `T3_TASK_CACHE_READ_TOKEN` secret.

- `knip.jsonc`: the four scripts only those workflows ran (`mirror-play-apk.cjs`, `resolve-nightly-release.ts`,
  `smoke-cli-archive.ts`, `apps/web/scripts/verify-built-boot.ts`) are entries, kept for upstream merges.
- `scripts/build-desktop-artifact.test.ts`: removed the case that read `desktop-macos-preview-publish.yml`.

## Deleted workflows

- `agent-context-budget.yml`: failed a PR that raised `agentContextBudget.json` above main's value.
- `deploy-relay.yml`: deployed the T3 Connect relay (Alchemy, Cloudflare, PlanetScale) on every push to main.
- `desktop-macos-preview.yml`: built the JS bundle of a PR for a macOS preview app, without secrets.
- `desktop-macos-preview-publish.yml`: packaged, signed, notarized and published that macOS preview.
- `issue-labels.yml`: synced the repository's issue label definitions.
- `issue-vouch.yml`: labeled issues by whether their author is in `VOUCHED.td`.
- `mobile-android-apk.yml`: mirrored each new Google Play beta APK to a GitHub prerelease every hour.
- `mobile-dev-client.yml`: built the iOS and Android development clients into the shared native-client cache.
- `mobile-eas-preview.yml`: built Expo EAS preview apps for same-repository PRs and commented the links.
- `mobile-eas-preview-fork.yml`: did the same for labeled fork PRs.
- `mobile-eas-production.yml`: built and submitted the production mobile apps and OTA updates.
- `mobile-fingerprint-check.yml`: detected whether a PR changes the mobile native fingerprint.
- `mobile-fingerprint-label.yml`: applied the "Native Change" label from that check.
- `mobile-showcase-screenshots.yml`: captured the mobile store screenshots on demand.
- `pr-limits.yml`: enforced upstream's open-PR limit and closed PRs after their triage window.
- `pr-size.yml`: labeled PRs by size.
- `pr-vouch.yml`: labeled PRs by whether their author is vouched, and managed the vouch list from comments.
- `publish-aur.yml`: published the Arch Linux AUR package.
- `relay-preview.yml`: deployed a relay preview stage for a PR labeled `relay:preview`.
- `relay-preview-cleanup.yml`: tore those relay preview stages down.
- `release.yml`: built, signed and published the desktop, CLI, web and marketing releases and nightlies.
- `release-desktop.yml`: built one signed desktop target, called from `release.yml`.
- `stale-needs-more-info.yml`: closed stale "needs more info" issues.
- `thread-transfer-report.yml`: posted CI's thread-transfer budget report on PRs.
- `web-preview.yml`: deployed a Vercel web preview for a PR labeled `preview:web`.
- `windows-tests.yml`: ran a chosen package's tests on Windows on demand.

## Other deleted `.github` files

- `actions/` (six composite actions): used only by the deleted workflows and upstream's CI.
- `ISSUE_TEMPLATE/`: linked upstream's Discussions and its `t3 triage` reports.
- `SECURITY.md`: sent vulnerability reports to upstream's security address.
- `VOUCHED.td`, `TRIAGE_EXEMPTIONS.td`: upstream's lists of trusted contributors and maintainers.
- `scripts/vercel-deployment-output.test.cjs`: read the deleted `web-preview.yml` and upstream's Vercel steps in `release.yml`, which ours does not have, so it could only fail.

## Kept

- `scripts/`: `scripts/check-changed.ts` imports `ci-changes.cjs`, and `knip.jsonc` names scripts there.
  Most of the rest served only the deleted workflows. Removing them would mean changing files outside
  `.github/`, so they stay.
- `triage/PLAYBOOK.md`: `apps/server/src/triage/triagePrompt.test.ts` checks it byte for byte.
- `readme/hero.webp`: `README.md` shows it. `pull_request_template.md`: names no upstream person.
- No `CODEOWNERS` or `FUNDING.yml` existed.

## Now out of date outside `.github/` (not mine to change)

- `CONTRIBUTING.md` and `.agents/skills/contribution-triage/SKILL.md` link `VOUCHED.td`,
  `TRIAGE_EXEMPTIONS.td` and `pr-limits.yml`.
- `docs/operations/development.md`, `docs/operations/release.md` and `infra/relay/README.md` describe
  the deleted workflows.
