@echo off
REM ======================================================================
REM  One-click installer. Double-click once on a new machine.
REM  Safe to run again: finished steps are skipped.
REM
REM    install.cmd           ask before the optional GPU voices
REM    install.cmd --gpu     install the GPU voices without asking
REM    install.cmd --no-gpu  never install them
REM
REM  KEEP THIS FILE PURE ASCII - see the note in start-server.cmd.
REM  All Thai messages live in tools\install.py.
REM ======================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
title HongRian - install

REM Prefer the py launcher: a bare "python" may be the Microsoft Store stub.
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY (
    python -c "import sys" >nul 2>&1 && set "PY=python"
)

if not defined PY (
    echo.
    echo  Python was not found on this computer.
    echo.
    echo  1. The Python download page will open now.
    echo  2. Install Python 3.12 or newer.
    echo     IMPORTANT: tick "Add python.exe to PATH" on the first screen.
    echo  3. Run install.cmd again.
    echo.
    start "" "https://www.python.org/downloads/windows/"
    pause
    exit /b 1
)

%PY% tools\install.py %*

echo.
pause
