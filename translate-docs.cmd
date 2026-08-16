@echo off
REM ======================================================================
REM  Translate lecture handouts (PDF / DOCX / TXT / MD / HTML).
REM
REM    1. Download the attachment from Udemy as usual
REM       (the Resources button in the player)
REM    2. Drop the file, or a whole folder, onto this file
REM
REM  Results are .th.md files under out\docs\
REM  Code and archives (.zip .cs .js) and images are skipped.
REM
REM  KEEP THIS FILE PURE ASCII - see the note in start-server.cmd.
REM  The prompt for the path lives in Python so it can be in Thai.
REM ======================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

if "%~1"=="" (
    python -m udemy_th docs
) else (
    python -m udemy_th docs "%~1"
)

echo.
pause
