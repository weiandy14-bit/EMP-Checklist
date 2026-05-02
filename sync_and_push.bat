@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   Notion to GitHub
echo ========================================
echo.

echo [1/3] Notion sync...
python "C:\Users\user\EMP-Checklist\sync_notion.py"
if %errorlevel% neq 0 (
    echo.
    echo FAILED: sync_notion.py error
    pause
    exit /b 1
)

echo.
echo [2/3] Git commit...
git -C "C:\Users\user\EMP-Checklist" add index.html
git -C "C:\Users\user\EMP-Checklist" commit -m "sync from Notion"
if %errorlevel% neq 0 (
    echo No changes to commit
)

echo.
echo [3/3] Git push...
git -C "C:\Users\user\EMP-Checklist" push
if %errorlevel% neq 0 (
    echo.
    echo FAILED: push error
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done!
echo ========================================
echo.
pause
