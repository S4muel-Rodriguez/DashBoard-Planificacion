@echo off
title AlphaTrade Pro - Diario de Trading
color 0b
echo ======================================================================
echo    INICIANDO ALPHATRADE PRO - DIARIO DE TRADING CON IA
echo ======================================================================
echo.

:: Abrir automáticamente el navegador en localhost:3000 tras iniciar
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Verificar si Node.js está disponible
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Iniciando con Node.js en el puerto 3000...
    node server.js
    goto end
)

:: Si no hay Node, verificar Python
where python >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Iniciando con Python en el puerto 3000...
    python server.py
    goto end
)

:: Si no hay servidor disponible, abrir el archivo index.html directamente
echo [!] Abriendo directamente en el navegador...
start index.html

:end
pause
