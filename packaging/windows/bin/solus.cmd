@echo off
rem The solus command of the Solus desktop app, as VS Code's code.cmd: the app
rem runs its bundled CLI as Node. It moves and updates with the app.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
rem The CLI offers only the commands that work against the app's own server.
set "SOLUS_DESKTOP_CLI=1"
"%~dp0..\Solus.exe" "%~dp0..\resources\app.asar\dist\main\cli.js" %*
endlocal & exit /b %ERRORLEVEL%
