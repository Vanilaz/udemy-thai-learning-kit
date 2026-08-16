@echo off
REM ======================================================================
REM  Translate a whole course in one run.
REM
REM  Drop a course folder (e.g. courses\my-course) onto this file, or
REM  double-click and type the path when asked.
REM
REM  Lectures already done are skipped, so closing the window part way
REM  through and running it again is safe.
REM
REM  KEEP THIS FILE PURE ASCII - see the note in start-server.cmd.
REM  The prompt for the folder lives in Python so it can be in Thai.
REM ======================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

if "%~1"=="" (
    python -m udemy_th go --ask-folder
) else (
    python -m udemy_th go "%~1"
)

echo.
pause
