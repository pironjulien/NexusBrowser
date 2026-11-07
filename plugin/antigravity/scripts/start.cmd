@echo off
rem Antigravity Marketplace launcher. Antigravity expands only ${PLUGIN_ROOT}, so this file finds the NexusBrowser
rem engine installed on this PC and runs it with the plugin's arguments (--stdio-relay: stdio to the shared local
rem service). The engine in use is the one current.json names, as for every other caller (scripts\runtime.ps1,
rem Get-CurrentExe): the installer writes it only once a build is verified, and a rollback rewrites it. Its build
rem folder is %LOCALAPPDATA%\NexusBrowser\versions\<first 16 characters of its fingerprint>, built here from the hex
rem fingerprint rather than from the "exe" field, so that the path keeps any non-ASCII character of the user profile.
rem Without current.json, the legacy fixed folder of versions before 2.33.0. Never the newest folder on disk: it may be
rem a build not verified yet, or the one a rollback left.
rem Installs by NexusBrowser itself write their own declaration; this file serves the copy from the Marketplace.
setlocal DisableDelayedExpansion
set "ROOT=%LOCALAPPDATA%\NexusBrowser"
set "ENGINE="
set "LINE="
set "FP="
if not exist "%ROOT%\current.json" goto legacy
rem install-native.ps1 writes it with ConvertTo-Json: one "key": value pair per line (Windows PowerShell or pwsh).
for /f "usebackq delims=" %%L in (`findstr /c:"\"fingerprint\"" "%ROOT%\current.json"`) do set "LINE=%%L"
if not defined LINE goto legacy
set "LINE=%LINE:*"fingerprint"=%"
set "LINE=%LINE:*:=%"
for %%F in (%LINE%) do if not defined FP set "FP=%%~F"
if not defined FP goto legacy
set "ENGINE=%ROOT%\versions\%FP:~0,16%\NexusBrowser.exe"
if exist "%ENGINE%" goto run
:legacy
set "ENGINE=%ROOT%\native\NexusBrowser.exe"
if exist "%ENGINE%" goto run
>&2 echo NexusBrowser is not installed on this PC. Ask Antigravity to install it ^(see the nexus-browser skill^), or follow https://github.com/pironjulien/NexusBrowser#install, then open a new conversation.
exit /b 1
:run
"%ENGINE%" %*
exit /b %ERRORLEVEL%
