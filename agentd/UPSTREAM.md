# Following upstream

AgentD Next is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (`pingdotgg/t3code`, MIT). We forked at `f5f8c8d1` and keep merging upstream, so most fixes and features come to us for free. Everything here exists to keep that merge cheap.

## Remotes

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git   # once
```

`origin` is `libraos/agentd-next`. `upstream` is only fetched from, never pushed to.

## What we keep from upstream

Everything not listed below: the server, orchestration, providers and their adapters, checkpointing, the web, desktop and mobile clients, remote access, the build and release tooling, and upstream's rules in `AGENTS.md`. When in doubt, take upstream's version.

## What we change

Each change to an upstream file is small and listed, one line per file with the reason, in `agentd/patches/<issue>-<slug>.md`. `agentd/scripts/list-patches.sh` prints every upstream file we changed since the fork point with its line counts, so the size of the patch set is one command away. If that list grows, move code out of upstream files into our own.

By area:

- **Name and branding.** The product is AgentD Next. No upstream name, icon or hosted service (app.t3.codes, T3 Connect, update feeds, stores) ships in our builds.
- **Product profile.** agentd is the authority for tasks, approvals and worker state; the app reads them from agentd and keeps no copy of its own as the truth. The app has no model access and prefers no agent.
- **Hidden features.** Upstream features we do not offer are hidden behind the product profile, not deleted, so their code still merges cleanly.
- **Our own code.** New code lives under `agentd/`, `apps/web/src/components/agentd/` and `apps/server/src/agentd/` where it can. Files that are ours alone never conflict.

See `agentd/patches/` for the current list.

## How often

Merge upstream at least once a week, and before starting any task that touches an upstream file we have patched. Small, frequent merges have small conflicts.

## How to merge

```bash
agentd/scripts/sync-upstream.sh --dry-run   # how far behind, and the files both sides changed
agentd/scripts/sync-upstream.sh             # merge into a new branch sync/upstream-<date>
```

The script fetches `upstream`, reports how many commits we are behind and ahead, and lists the files changed both by us and by upstream since the merge base: those are where conflicts and silent breakage come from. Without `--dry-run` it creates `sync/upstream-<date>` from the current commit and merges `upstream/main` into it. It never pushes and never touches `main`. `--dry-run` changes no branch, index or working tree; it only updates the `upstream/main` remote-tracking ref (`--no-fetch` skips even that).

After the merge: resolve conflicts, run `vp i`, run `vp run check:changed` and the tests near each conflicted file, then open a pull request from the sync branch to `main`. Merge it with a merge commit, not a squash, so the next merge base is upstream's commit.

## Resolving the usual conflicts

- **Ours** for the product name, the product profile and the hidden features: keep our lines, then re-apply them on top of upstream's new code if upstream moved the surrounding code.
- **Theirs** for everything else. If upstream rewrote code we patched, take theirs and redo our patch as a smaller change, then update its line in `agentd/patches/`.
- `pnpm-lock.yaml`: take upstream's, then run `vp i` to regenerate it.
- `AGENTS.md`: keep our "AgentD Next" section at the top and take upstream's text for the rest.
- `README.md` is ours entirely; `LICENSE` is upstream's and never changes here.
- Translation catalogs (`*/i18n/translations/*.json`): take upstream's, then regenerate once with `vp run i18n:generate` and translate our keys.

## Versions

Our version is our own, in `apps/desktop/package.json` (a patched upstream file: keep ours in a sync). It started at `0.2.0`; minor for features, patch for fixes. The upstream base is the synced commit named above, not part of the version. Releases up to `0.1.10-agentd.8` were `<upstream version>-agentd.N`. A test build for other people is `x.y.z-preview.<yyyymmdd>.<n>`: the packager gives it no update feed, and the release workflow does not run for its tag.
