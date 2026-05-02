@echo off
chcp 65001 >nul
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
