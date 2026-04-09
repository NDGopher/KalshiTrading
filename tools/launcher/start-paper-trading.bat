@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Kalshi paper trading launcher

REM ---- Repo root (this file is tools\launcher\start-paper-trading.bat) ----
pushd "%~dp0..\.." 2>nul
if errorlevel 1 (
  echo [ERROR] pushd failed for "%~dp0..\.."
  pause
  exit /b 1
)
set "REPO=%CD%"
set "SETTINGS_JSON=%~dp0put-settings-body.json"

echo.
echo ============================================================
echo   Kalshi paper stack: API :3000 + Dashboard :5173
echo   Repo: %REPO%
echo ============================================================
echo.

if not exist "%REPO%\.env" (
  echo [WARN] No .env at repo root — API may fail without DATABASE_URL / keys.
  echo.
)

if not exist "%SETTINGS_JSON%" (
  echo [ERROR] Missing settings file:
  echo   "%SETTINGS_JSON%"
  popd
  pause
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm not on PATH. Install Node.js and pnpm first.
  popd
  pause
  exit /b 1
)

where curl >nul 2>&1
if errorlevel 1 (
  echo [ERROR] curl not found. Install Git for Windows or Windows curl.
  popd
  pause
  exit /b 1
)

REM ---- 0) Fresh clone / new PC: dependencies (repo cwd is already REPO from pushd above) ----
if not exist "node_modules\" (
  echo [0/5] No node_modules — running pnpm install ^(first run may take a few minutes^)...
  call pnpm install
  if errorlevel 1 (
    echo [ERROR] pnpm install failed. Fix errors above, then run this script again.
    popd
    pause
    exit /b 1
  )
  echo       Dependencies installed.
  echo.
)

REM ---- 1) API in new window: working dir = repo (no fragile "cd /d" quoting) ----
echo [1/5] Starting API in a new window (PORT=3000^)...
start "Kalshi Paper API (3000)" /D "%REPO%" cmd.exe /k "set PORT=3000&& pnpm --filter @workspace/api-server run dev"
if errorlevel 1 (
  echo [ERROR] Failed to start API window.
  popd
  pause
  exit /b 1
)

REM ---- 2) Wait for API ----
echo [2/5] Waiting for http://127.0.0.1:3000/api/healthz ...
set /a _w=0
:wait_health
curl -s -f "http://127.0.0.1:3000/api/healthz" >nul 2>&1
if not errorlevel 1 goto health_ok
set /a _w+=1
if !_w! GEQ 90 (
  echo [ERROR] API did not become healthy in time.
  popd
  pause
  exit /b 1
)
ping 127.0.0.1 -n 3 >nul
goto wait_health
:health_ok
echo       API is up.

REM ---- 3) Paper reset (optional only) ----
REM By default we do NOT reset: paper_trades live in Postgres and should persist across
REM restarts and machines that share the same DATABASE_URL. Reset wipes ALL history.
REM To start from a clean slate: set RESET_PAPER=1 before running this script, or use
REM Dashboard Paper page / Settings, or: pnpm paper:reset:async (API must be up).
if /i "%RESET_PAPER%"=="1" (
  echo [3/5] RESET_PAPER=1 — wiping paper_trades and restoring balance ^(async^)...
  curl -s -S -m 60 -X POST "http://127.0.0.1:3000/api/paper-trades/reset?async=1"
  if errorlevel 1 (
    echo [WARN] Paper reset request failed — check API log.
  ) else (
    echo       Paper reset OK.
  )
) else (
  echo [3/5] Keeping existing paper trade history ^(no reset^). Set RESET_PAPER=1 to wipe.
)
echo.

echo [4/5] Applying settings (3 min scan, 4 keepers, uncapped positions, $15 target^)...
curl -sS -m 90 -X PUT "http://127.0.0.1:3000/api/settings" -H "Content-Type: application/json" --data-binary "@%SETTINGS_JSON%"
if errorlevel 1 (
  echo [WARN] PUT settings failed — check API log.
) else (
  echo       Settings applied.
)
echo.

REM ---- 4) Dashboard ----
echo [5/5] Starting Dashboard in a new window (PORT=5173, BASE_PATH=/^)...
start "Kalshi Dashboard (5173)" /D "%REPO%" cmd.exe /k "set PORT=5173&& set BASE_PATH=/ && pnpm --filter @workspace/dashboard run dev"
if errorlevel 1 (
  echo [ERROR] Failed to start Dashboard window.
  popd
  pause
  exit /b 1
)

REM ~5s delay without using TIMEOUT (breaks if stdin is redirected e.g. piped tests)
ping 127.0.0.1 -n 6 >nul
start "" "http://localhost:5173/"

echo.
echo ============================================================
echo   Dashboard is now open at http://localhost:5173
echo   Watch Recent paper trades table and Positions tab for live activity and equity/PnL
echo ============================================================
echo.
echo   API:        http://127.0.0.1:3000
echo   Dashboard:  http://localhost:5173
echo   Settings:   %SETTINGS_JSON%
echo.
echo Leave this window open for the message above. Close the two titled
echo windows "Kalshi Paper API (3000)" and "Kalshi Dashboard (5173)" to stop servers.
echo.

popd
pause
endlocal
exit /b 0
