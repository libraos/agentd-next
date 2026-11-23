!include "StrFunc.nsh"
!include "${__FILEDIR__}\agentd-uninstall.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
!endif

; An update from AgentD Next (agentd.6 or earlier: AgentD Desktop) still runs an earlier name.
!define LEGACY_APP_NAME "AgentD Desktop"
!define LEGACY_NIGHTLY_APP_NAME "AgentD Desktop (Nightly)"
!define PREVIOUS_APP_NAME "AgentD Next"
!define PREVIOUS_NIGHTLY_APP_NAME "AgentD Next (Nightly)"

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:T3CODE_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'LibraOS Next', 'LibraOS Next (Nightly)', '${PREVIOUS_APP_NAME}', '${PREVIOUS_NIGHTLY_APP_NAME}', '${LEGACY_APP_NAME}', '${LEGACY_NIGHTLY_APP_NAME}' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "LibraOS Next"
      ${OrIf} $1 == "LibraOS Next (Nightly)"
      ${OrIf} $1 == "${PREVIOUS_APP_NAME}"
      ${OrIf} $1 == "${PREVIOUS_NIGHTLY_APP_NAME}"
      ${OrIf} $1 == "${LEGACY_APP_NAME}"
      ${OrIf} $1 == "${LEGACY_NIGHTLY_APP_NAME}"
        ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
