; AgentD: on a real uninstall (not an update), remove the agentd this app installed for the user
; (apps/desktop/src/backend/agentdInstall.ts) and its user PATH entry, only while the app's marker
; says the binary is ours. agentd's data (AGENTD_ROOT) is never touched.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    Push $R0
    ReadEnvStr $R0 LOCALAPPDATA
    StrCpy $R0 "$R0\Programs\agentd"
    ${if} ${FileExists} "$R0\agentd-desktop-installed"
      ; Every other PATH entry stays as written; REG_EXPAND_SZ stays expandable.
      System::Call 'kernel32::SetEnvironmentVariable(t "AGENTD_UNINSTALL_DIR", t "$R0")'
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); $$v = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$d = $$env:AGENTD_UNINSTALL_DIR.TrimEnd('\'); $$all = @($$v -split ';' | Where-Object { $$_ -ne '' }); $$kept = @($$all | Where-Object { $$_.Trim().TrimEnd('\') -ne $$d }); if ($$kept.Count -ne $$all.Count) { $$k.SetValue('Path', ($$kept -join ';'), $$k.GetValueKind('Path')) } } catch { exit 1 }"`
      Pop $0
      System::Call 'kernel32::SetEnvironmentVariable(t "AGENTD_UNINSTALL_DIR", p 0)'
      ; WM_SETTINGCHANGE to HWND_BROADCAST, so new terminals see the PATH without the entry.
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
      Delete "$R0\agentd.exe"
      Delete "$R0\agentd.exe.old"
      Delete "$R0\libraos-engine.exe"
      Delete "$R0\libraos-engine.exe.old"
      Delete "$R0\agentd-desktop-installed"
      RMDir "$R0"
    ${endIf}
    Pop $R0
    Pop $0
  ${endIf}
!macroend
