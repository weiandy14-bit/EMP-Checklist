@echo off
chcp 65001 >nul
set NOTION_TOKEN=ntn_Y36273413268N3qINTubBtDxXTJUiBSr3w36Il3SNaK29v
echo.
echo ========================================
echo   MEP Report to Notion
echo ========================================
echo.
python "C:\Users\user\EMP-Checklist\push_report.py"
if %errorlevel% neq 0 (
    echo.
    echo FAILED: push_report.py error
    pause
    exit /b 1
)
