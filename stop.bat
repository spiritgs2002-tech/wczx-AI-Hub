@echo off
chcp 65001 >nul
title wczx-AI-Hub 停止器

rem 停止 wczx-AI-Hub 服务：查找占用 3000 端口的进程并结束
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3000 " ^| findstr /c:"LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    if not errorlevel 1 set "FOUND=1"
)

if defined FOUND (
    echo wczx-AI-Hub 已停止
) else (
    echo 未发现运行中的 wczx-AI-Hub
    echo 若仍提示文件被占用，可手动执行：taskkill /F /IM node.exe
)

pause
