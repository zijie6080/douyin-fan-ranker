@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

echo ============================================
echo   重置抖音登录 (清除已保存的登录状态)
echo ============================================
echo.
echo 这会删除本工具保存的浏览器登录信息，
echo 下次运行需要重新登录抖音。
echo （不会影响你平时用的 Chrome 浏览器。）
echo.
set /p CONFIRM=确定要重置吗？输入 y 回车确认：
if /i not "%CONFIRM%"=="y" (
  echo 已取消。
  pause
  exit /b 0
)

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 没有检测到 Node.js，无法执行。
  pause
  exit /b 1
)

call npm run reset-login
echo.
pause
endlocal
