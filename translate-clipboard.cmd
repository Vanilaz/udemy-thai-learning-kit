@echo off
REM ======================================================================
REM  Translate a transcript copied from Udemy.
REM
REM    1. Open the video, click Transcript
REM    2. Select all of it and press Ctrl+C
REM    3. Double-click this file
REM
REM  KEEP THIS FILE PURE ASCII - see the note in start-server.cmd.
REM ======================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

python -m udemy_th go

echo.
pause
