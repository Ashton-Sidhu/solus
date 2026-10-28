; The `solus` command of the Windows desktop app (docs/plans/windows.md §13.5),
; as VS Code ships `code`: the app carries `bin\solus.cmd`, and the installer
; puts that folder on the user PATH. electron-builder includes this file
; (package.json `build.nsis.include`); its hooks run after the files are
; copied, and before they are deleted.
;
; The PATH edit is a PowerShell script shipped in resources: NSIS string
; functions cut a long PATH at 1024 characters.

!macro solusPathEntry ACTION
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\path-entry.ps1" -${ACTION} "$INSTDIR\bin"'
  Pop $0
!macroend

!macro customInstall
  !insertmacro solusPathEntry Add
!macroend

!macro customUnInstall
  ; An update uninstalls the old version first; the folder stays on the PATH.
  ${ifNot} ${isUpdated}
    !insertmacro solusPathEntry Remove
  ${endIf}
!macroend
