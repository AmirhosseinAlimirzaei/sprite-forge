@echo off
title Sprite Forge - local server
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
    py server.py %*
) else (
    python server.py %*
)

if errorlevel 1 (
    echo.
    echo The server stopped with an error. Press any key to close.
    pause >nul
)
