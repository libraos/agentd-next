# Windows: plugin setups find the engine, and .py MCP servers start

Found on LibraOS Next 0.4.1 on Windows 11 (libraos/next#317). A plugin setup that ran
`libraos-engine` failed because the app installed the engine for terminals only as `agentd.exe`.
A plugin MCP server whose command was a `.py` file failed with os error 193, because Windows
cannot start a script by itself.

- **Engine name.** On Windows the install pass also places the bundled engine as
  `libraos-engine.exe` beside `agentd.exe`, under the same never-downgrade rule. A folder whose
  `agentd.exe` the user put there gets no `libraos-engine.exe` from the app. macOS and Linux
  still install only `agentd`.
- **Setups.** A setup gets the engine's path in `LIBRAOS_ENGINE` (`AGENTD_BIN`, else the first
  engine name on PATH). A hook, setup or MCP command naming the engine that is not on PATH runs
  that engine, which covers the running app whose PATH predates the install.
- **Python.** On Windows a `.py` file inside the plugin's folder starts through `py -3`, else
  `python` (past the Store stubs), found on PATH. Only Next picks it: no setting, env value or
  other manifest field does, and the manifest's args come after the script. With neither, the
  setup fails and the plugin page shows the server's problem, saying to install Python 3 from
  python.org. macOS and Linux start the file as before.
- **Device code.** The sign-in device code wraps instead of being clipped in a narrow card.

## Files outside our folders

- `apps/desktop/src/backend/agentdInstall.ts`: places `libraos-engine.exe` on Windows; the
  placement is one function used for both names.
- `apps/desktop/src/backend/agentdBinary.ts`: `engineBinaryName`.
- `apps/desktop/resources/agentd-uninstall.nsh`: removes `libraos-engine.exe` and its `.old`.
- `apps/desktop/src/backend/agentdInstall.test.ts`: install pass tests for the second name.
- `packages/contracts/src/agentdPlugins.ts`: optional `problem` on a plugin's MCP server.
- `apps/web/src/components/settings/SourceControlAppSignInSettings.tsx`: the device-code panel
  and code wrap (`flex-wrap`) instead of a fixed two-column grid.
