# 100: tests that cannot run on Windows say so

Issue #100: on a Windows VM, `infra/task-cache/src/runHook.test.ts` failed because one of its cases runs
bash. That case tests the POSIX shell setup: that the installer leaves `~/.profile` alone and that the CI
env file works when bash sources it through `BASH_ENV`. Windows has no such setup, so the case is skipped
there, with the reason written above it. Linux and macOS run it as before.

Upstream files changed:

- `infra/task-cache/src/runHook.test.ts`: "installs without masking .profile and configures CI through
  bash" runs through `itPosix`, which is `it.skipIf(process.platform === "win32")`. I used a named alias
  instead of wrapping the call, so the body keeps its indentation and the diff against upstream is three
  added lines.

How it was checked: on Linux all 6 cases pass. To mimic Windows, I ran a temporary copy of the file with
`process.platform` set to `"win32"` before the cases are defined. With this change the bash case is
skipped (5 passed, 1 skipped). Without it, the case runs.

Still open in #100:

- The issue counts 2 Windows failures in this file. Only the bash case is known to need bash. The other
  could not be identified on Linux. One guess: several cases set `HOME`, but on Windows `os.homedir()` reads
  `USERPROFILE`.
- The 246 server test failures and the web browser tests, which need a Windows machine.
