@echo off
rem electron.exe is a GUI binary: started via "start" it gets no console of its own,
rem and this batch window closes immediately after launching it.
set "APP=%~dp0desktop-app"
if not exist "%APP%\node_modules\electron\install.js" (
  echo Dependencies missing. Run: cd desktop-app ^&^& npm install
  pause
  exit /b 1
)
rem Electron 45+ downloads its binary on first use rather than at npm install.
if not exist "%APP%\node_modules\electron\dist\electron.exe" (
  echo Downloading Electron binary, one time only...
  node "%APP%\node_modules\electron\install.js" || (pause & exit /b 1)
)
start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%"
exit
