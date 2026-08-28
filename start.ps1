# 抖音粉丝分析工具 (Douyin Fan Ranker) - PowerShell 启动脚本
# 使用方法：右键此文件 -> 使用 PowerShell 运行；
# 或在 PowerShell 里执行： powershell -ExecutionPolicy Bypass -File .\start.ps1

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -Path $PSScriptRoot

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  抖音粉丝分析工具 (Douyin Fan Ranker)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "当前目录: $((Get-Location).Path)"
Write-Host ""

# 1. 检查 Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host "[错误] 没有检测到 Node.js。" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先安装 Node.js（建议 18 或更高版本）："
    Write-Host "  下载地址： https://nodejs.org/zh-cn"
    Write-Host "安装完成后，重新运行本脚本。"
    Read-Host "按回车键退出"
    exit 1
}

Write-Host "[信息] 已检测到 Node.js： $(node --version)" -ForegroundColor Green
Write-Host ""

# 2. 安装依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "[信息] 第一次运行，正在安装依赖，请耐心等待……" -ForegroundColor Yellow
    Write-Host "（这一步只有第一次需要，可能需要几分钟）"
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] 依赖安装失败，请检查网络后重试。" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
    Write-Host "[信息] 正在安装浏览器组件……" -ForegroundColor Yellow
    npx playwright install chromium
}

Write-Host ""
Write-Host "[信息] 启动程序，浏览器会自动打开……" -ForegroundColor Green
Write-Host ""
npm start

Write-Host ""
Write-Host "程序已结束。结果保存在 output 文件夹里。" -ForegroundColor Cyan
Read-Host "按回车键退出"
