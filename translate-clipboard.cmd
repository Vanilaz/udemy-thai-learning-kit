@echo off
REM ======================================================================
REM  ดับเบิลคลิกไฟล์นี้ หลังจากก๊อป transcript จาก Udemy แล้ว (Ctrl+C)
REM
REM  วิธีใช้:
REM    1. เปิดวิดีโอใน Udemy กดปุ่ม Transcript
REM    2. เลือกข้อความทั้งหมด แล้วกด Ctrl+C
REM    3. ดับเบิลคลิกไฟล์นี้
REM ======================================================================

REM UTF-8 code page so Thai output is readable in the console.
chcp 65001 >nul
cd /d "%~dp0"

python -m udemy_th go

echo.
pause
