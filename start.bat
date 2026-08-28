@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

echo ============================================
echo   抖音粉丝分析工具 (Douyin Fan Ranker)
echo ============================================
echo.
echo 当前目录: %cd%
echo.

REM 1. 检查 Node.js 是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 没有检测到 Node.js。
  echo.
  echo 请先安装 Node.js（建议 18 或更高版本）：
  echo   下载地址： https://nodejs.org/zh-cn
  echo 安装完成后，重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo [信息] 已检测到 Node.js：
node --version
echo.

REM 2. 如果没有安装依赖，自动安装
if not exist "node_modules" (
  echo [信息] 第一次运行，正在安装依赖，请耐心等待……
  echo （这一步只有第一次需要，可能需要几分钟）
  echo.
  call npm install
  if %errorlevel% neq 0 (
    echo.
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
  echo.
  echo [信息] 正在安装浏览器组件……
  call npx playwright install chromium
)

echo.
echo [信息] 启动程序，请稍候，浏览器会自动打开……
echo.
call npm start

echo.
echo 程序已结束。结果保存在 output 文件夹里。
pause
endlocal
