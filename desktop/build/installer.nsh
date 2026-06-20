!macro installPeekRemoteElevatedTasks
  InitPluginsDir
  File /oname=$PLUGINSDIR\install-elevated-tasks.ps1 "${BUILD_RESOURCES_DIR}\install-elevated-tasks.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-elevated-tasks.ps1" -ExePath "$appExe"'
!macroend

!macro removePeekRemoteElevatedTasks
  InitPluginsDir
  File /oname=$PLUGINSDIR\remove-elevated-tasks.ps1 "${BUILD_RESOURCES_DIR}\remove-elevated-tasks.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-elevated-tasks.ps1"'
!macroend

!macro customInstall
  !insertmacro installPeekRemoteElevatedTasks
!macroend

!macro customUnInstall
  !insertmacro removePeekRemoteElevatedTasks
!macroend
