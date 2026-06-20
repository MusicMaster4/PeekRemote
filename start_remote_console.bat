@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Peek Remote - Remote Console

REM --- 0) Privilegios de Administrador ---
REM  Necessarios para enviar mouse/teclado a janelas ELEVADAS (ex.: Gerenciador
REM  de Tarefas). O Windows (UIPI) bloqueia input de um processo comum para
REM  janelas admin. Se nao estivermos elevados, reabrimos via UAC.
net session >nul 2>&1
if not errorlevel 1 goto :is_admin
echo [setup] Solicitando privilegios de Administrador ^(UAC^)...
if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
)
exit /b
:is_admin

pushd "%~dp0"

REM ============================================================
REM  Peek Remote
REM  - Backend FastAPI (captura de tela / controle remoto / suspender)
REM  - Frontend Next.js (build estatico servido pelo FastAPI)
REM
REM  Uso:
REM    start_remote_console.bat            inicia o servidor
REM    start_remote_console.bat rebuild    recompila o frontend e inicia
REM ============================================================

REM --- 1) Ambiente virtual do Python ---
if not exist ".venv\Scripts\activate.bat" (
    echo [ERRO] Ambiente virtual nao encontrado.
    echo        Crie com:  python -m venv .venv
    echo        E instale: .venv\Scripts\python -m pip install -r requirements.txt
    pause
    exit /b 1
)

REM --- 2) Node.js / npm disponivel? ---
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js/npm nao encontrado no PATH.
    echo        Instale o Node.js LTS em https://nodejs.org e tente novamente.
    pause
    exit /b 1
)

REM --- 3) Dependencias do frontend ---
if not exist "web\node_modules" (
    echo [setup] Instalando dependencias do frontend ^(primeira vez^)...
    pushd web
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha no "npm install".
        popd
        pause
        exit /b 1
    )
    popd
)

REM --- 4) Build do frontend (Next.js export estatico) ---
set "NEED_BUILD="
if /I "%~1"=="rebuild" set "NEED_BUILD=1"
if not exist "web\out\index.html" set "NEED_BUILD=1"

if defined NEED_BUILD (
    echo [setup] Compilando a interface Next.js...
    pushd web
    call npm run build
    if errorlevel 1 (
        echo [ERRO] Falha no build do Next.js.
        popd
        pause
        exit /b 1
    )
    popd
)

REM --- 5) Iniciar o servidor ---
echo.
echo ============================================================
echo   Peek Remote - iniciando servidor (modo Administrador)
echo   Acesso privado via Tailscale (sem link publico na internet).
echo   No celular, abra: https://SEU-PC.SUA-TAILNET.ts.net
echo   Mantenha esta janela aberta enquanto usa o acesso remoto.
echo ============================================================
echo.

call ".venv\Scripts\activate.bat"
python serve.py

popd
echo.
echo Servidor encerrado.
pause
