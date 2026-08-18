@echo off
setlocal EnableExtensions
set "GRIDBOT_EXIT=1"

cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] 无法进入程序目录。
  goto failure
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 未找到 Windows PowerShell。
  goto failure
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-launcher.ps1"
set "GRIDBOT_EXIT=%ERRORLEVEL%"
if not "%GRIDBOT_EXIT%"=="0" goto failure
goto done

:failure
echo.
echo [ERROR] 启动失败。退出码: %GRIDBOT_EXIT%
echo 详细信息见上方输出。请截图此窗口反馈。
echo.
pause

:done
endlocal & exit /b %GRIDBOT_EXIT%
