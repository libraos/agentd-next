# 149, 150: Hand to a worker from a draft thread and from the default branch

Issues #149 and #150.

**#149.** In a new thread that is still a draft, the dialog found no server thread, so it had no
working directory and Start stayed disabled. The dialog now takes the draft's project (and its
worktree, when the draft has one) from the composer's draft store, as the branch toolbar does.

**#150.** The dialog refused a checkout on `main` or `master`. agentd gives a worker started there
a new linked worktree and branch of its own, so the refusal is gone; the summary says
"Runs on a new branch in its own worktree, from main." instead. The not-a-repository and detached
refusals stay. The thread nudge still offers only Cloud Workers on the default branch; that is
unchanged here.

## Upstream files changed

- `apps/web/src/i18n/translations/*.json`: one new string, translated in every locale; the old
  refusal's string is dropped.
- `docs/user/workers.md`: a worker can start from `main` or `master`.
