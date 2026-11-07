@echo off
rem Antigravity Marketplace launcher. Antigravity expands only ${PLUGIN_ROOT}, so this file finds the NexusBrowser
rem engine installed on this PC (get.ps1 or install.ps1: %LOCALAPPDATA%\NexusBrowser\versions\<build>\NexusBrowser.exe,
rem one immutable folder per build, the newest first; folders still being copied end in .tmp-<pid> and are skipped)
rem and runs it with the plugin's arguments (--stdio-relay: stdio to the shared local service).
rem Installs by NexusBrowser itself write their own declaration; this file serves the copy from the Marketplace.
setlocal
set "VERSIONS=%LOCALAPPDATA%\NexusBrowser\versions"
set "ENGINE="
if exist "%VERSIONS%\" for /f "delims=" %%D in ('dir /b /ad /o-d "%VERSIONS%" 2^>nul') do (
    if not defined ENGINE if "%%~xD"=="" if exist "%VERSIONS%\%%D\NexusBrowser.exe" set "ENGINE=%VERSIONS%\%%D\NexusBrowser.exe"
)
if not defined ENGINE if exist "%LOCALAPPDATA%\NexusBrowser\native\NexusBrowser.exe" set "ENGINE=%LOCALAPPDATA%\NexusBrowser\native\NexusBrowser.exe"
if defined ENGINE goto run
>&2 echo NexusBrowser is not installed on this PC. Ask Antigravity to install it ^(see the nexus-browser skill^), or follow https://github.com/pironjulien/NexusBrowser#install, then open a new conversation.
exit /b 1
:run
"%ENGINE%" %*
exit /b %ERRORLEVEL%
