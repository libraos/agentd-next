# Release notes say what changed: What's new from docs/release-notes/VERSION.md

The draft release's notes were a fixed template: they never said what changed, repeated the migration
paragraph at the end and still used old names. Now `agentd/scripts/release-notes.sh` writes them: the
version line, "What's new in VERSION" from `docs/release-notes/VERSION.md` (added in the version bump), then
the fixed help, worded as the hand-edited v0.4.1 notes (macOS updates in place from 0.4.0; one line for
installs under the old name, detail in `docs/user/updating.md`). The `prepare` job runs it first and fails a
tag whose version has no notes file. The script reads the file with `cat`, so nothing in it reaches the
shell as code.

Upstream files changed:

- `apps/desktop/src/updates/releaseNotes.ts`: notes with a "What's new in VERSION" heading show only that
  list, in order, in the update prompt (before: the last eight lines, reversed, which were download help).
- `apps/desktop/src/updates/releaseNotes.test.ts`: the new layout, as Markdown and as the feed's HTML.

Ours: `.github/workflows/release.yml` (check in `prepare`, notes from the script), `agentd/scripts/release-notes.sh`,
`scripts/agentd-release-notes.test.ts`, `docs/release-notes/0.4.1.md`, `agentd/design/build.md` ("Cutting a release").
