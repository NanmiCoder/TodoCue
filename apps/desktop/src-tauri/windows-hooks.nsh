!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\runtime\bin\node.exe" 0 todocue_stop_done
    nsExec::ExecToLog '$\"$INSTDIR\runtime\bin\node.exe$\" $\"$INSTDIR\runtime\packages\cli\dist\index.js$\" windows-integration stop'
    Pop $0
    StrCmp $0 "0" todocue_stop_done
      Abort "TodoCue background runtime could not stop. Please close it before upgrading."
  todocue_stop_done:
!macroend
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "DisplayName" "TodoCue"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "IconUri" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\todocue" "" "URL:TodoCue"
  WriteRegStr HKCU "Software\Classes\todocue" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\todocue\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  nsExec::ExecToLog '$\"$INSTDIR\runtime\bin\node.exe$\" $\"$INSTDIR\runtime\packages\cli\dist\index.js$\" windows-integration start'
  Pop $0
  StrCmp $0 "0" todocue_start_done
    MessageBox MB_OK|MB_ICONSTOP "TodoCue background runtime could not restart ($0). Your data and recovery settings have been kept. Check its background logs and scheduled task, then retry the installation." /SD IDOK
    SetErrorLevel 1
    Abort
  todocue_start_done:
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  ; Remove only integration. The ~/.todocue database and backups stay intact.
  ; Tauri can invoke the old uninstaller before the new PREINSTALL hook.
  ; /UPDATE and its _?= maintenance invocation preserve directory associations.
  StrCpy $0 "uninstall"
  ${If} $UpdateMode = 1
    StrCpy $0 "stop"
  ${Else}
    ${GetOptions} $CMDLINE "_?=" $1
    ${IfNot} ${Errors}
      StrCpy $0 "stop"
    ${EndIf}
  ${EndIf}
  nsExec::ExecToLog '$\"$INSTDIR\runtime\bin\node.exe$\" $\"$INSTDIR\runtime\packages\cli\dist\index.js$\" windows-integration $0'
  Pop $0
  StrCmp $0 "0" todocue_uninstall_done
    Abort "TodoCue integration could not be removed. Data has been kept; retry after closing its runtime."
  todocue_uninstall_done:
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $0 HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "IconUri"
  StrCmp $0 "$INSTDIR\${MAINBINARYNAME}.exe" 0 todocue_appid_done
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\${BUNDLEID}"
  todocue_appid_done:
  ReadRegStr $0 HKCU "Software\Classes\todocue\shell\open\command" ""
  StrCmp $0 '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"' 0 todocue_protocol_done
    DeleteRegKey HKCU "Software\Classes\todocue"
  todocue_protocol_done:
!macroend
