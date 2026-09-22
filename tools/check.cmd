@echo off
REM dsh-manju-studio pre-delivery check. Runs the syntax gate and every suite.
REM Usage: tools\check.cmd
set ELECTRON_RUN_AS_NODE=1
"D:\Ai\DSH Desktop\DSH Desktop.exe" "%~dp0check.mjs"
exit /b %ERRORLEVEL%
