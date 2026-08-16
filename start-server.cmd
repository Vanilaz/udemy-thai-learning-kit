@echo off
REM ======================================================================
REM  Start the subtitle translation server.
REM  Double-click before class and leave the window open, then play a
REM  Udemy video as usual. Thai subtitles appear on their own.
REM
REM  KEEP THIS FILE PURE ASCII.
REM  cmd.exe loses its place in a batch file that contains non-ASCII bytes
REM  while the console code page is UTF-8 (65001), and ends up running
REM  fragments of later lines as commands. Thai text belongs in the Python
REM  output, which handles it correctly.
REM ======================================================================

chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
title Udemy TH - subtitle server

python -m udemy_th serve

echo.
pause
