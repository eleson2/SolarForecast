@echo off
:: Run this as Administrator to install SolarForecast as a Windows Service via NSSM.
:: The service starts automatically at boot without requiring a user login.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Please run this script as Administrator.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-autostart.ps1"

if %errorlevel% equ 0 (
    echo.
    echo SUCCESS: SolarForecast service installed and started.
    echo.
    echo Useful commands:
    echo   nssm status SolarForecast
    echo   nssm restart SolarForecast
    echo   nssm stop SolarForecast
    echo   nssm start SolarForecast
    echo   nssm remove SolarForecast confirm
) else (
    echo.
    echo FAILED: Check the error above.
)

pause
