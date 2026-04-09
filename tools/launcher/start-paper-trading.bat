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
  echo [0/6] No node_modules — running pnpm install ^(first run may take a few minutes^)...
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

REM ---- 1) Schema sync + log purge: keeps paper_trades + trading_settings; truncates bulky tables ----
REM     Uses DATABASE_URL from repo .env. SKIP_DB_PUSH=1 skips push; SKIP_PURGE=1 skips truncate.
if /i "%SKIP_DB_PUSH%"=="1" (
  echo [1/6] SKIP_DB_PUSH=1 — skipping pnpm db:push.
  echo.
) else (
  echo [1/6] Syncing database schema ^(pnpm db:push — keeps paper_trades rows^)...
  call pnpm db:push
  if errorlevel 1 (
    echo [ERROR] db:push failed. Set DATABASE_URL ^(repo .env^), check network/DB, then retry.
    echo        Or set SKIP_DB_PUSH=1 to start without syncing ^(not recommended^).
    popd
    pause
    exit /b 1
  )
  echo       Schema OK.
  if /i "%SKIP_PURGE%"=="1" (
    echo       SKIP_PURGE=1 — skipping non-essential table truncate.
  ) else (
    echo       Purging non-essential tables ^(paper_trades + settings kept^)...
    call node tools\db\purge-logs-except-paper.mjs
    if errorlevel 1 (
      echo [WARN] Purge failed — check DATABASE_URL and DB permissions. Continuing startup.
    )
  )
  echo.
)

REM ---- 1b) Free canonical ports so API/dashboard always bind 3000 / 5173 (not 5174+) ----
if /i "%SKIP_FREE_PORTS%"=="1" (
  echo [1b/6] SKIP_FREE_PORTS=1 — leaving listeners on 3000/5173 unchanged.
  echo.
) else (
  echo [1b/6] Stopping processes listening on 3000 ^(API^) and 5173 ^(dashboard^) — clears stale windows...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "3000,5173 | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
  ping 127.0.0.1 -n 2 >nul
  echo       Done. ^(Set SKIP_FREE_PORTS=1 to skip.^)
  echo.
)

REM ---- 2) API in new window: working dir = repo (no fragile "cd /d" quoting) ----
echo [2/6] Starting API in a new window (PORT=3000^)...
start "Kalshi Paper API (3000)" /D "%REPO%" cmd.exe /k "set PORT=3000&& set DASHBOARD_DEV_URL=http://127.0.0.1:5173/&& pnpm --filter @workspace/api-server run dev"
if errorlevel 1 (
  echo [ERROR] Failed to start API window.
  popd
  pause
  exit /b 1
)

REM ---- 3) Wait for API ----
echo [3/6] Waiting for http://127.0.0.1:3000/api/healthz ...
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
  echo [4/6] RESET_PAPER=1 — wiping paper_trades and restoring balance ^(async^)...
  curl -s -S -m 60 -X POST "http://127.0.0.1:3000/api/paper-trades/reset?async=1"
  if errorlevel 1 (
    echo [WARN] Paper reset request failed — check API log.
  ) else (
    echo       Paper reset OK.
  )
) else (
  echo [4/6] Keeping existing paper trade history ^(no reset^). Set RESET_PAPER=1 to wipe.
)
echo.

echo [5/6] Applying settings (3 min scan, 4 keepers, uncapped positions, $15 target^)...
curl -sS -m 90 -X PUT "http://127.0.0.1:3000/api/settings" -H "Content-Type: application/json" --data-binary "@%SETTINGS_JSON%"
if errorlevel 1 (
  echo [WARN] PUT settings failed — check API log.
) else (
  echo       Settings applied.
)
echo.

REM ---- 6) Dashboard ----
echo [6/6] Starting Dashboard in a new window (PORT=5173, BASE_PATH=/^)...
start "Kalshi Dashboard (5173)" /D "%REPO%" cmd.exe /k "set PORT=5173&& set BASE_PATH=/&& pnpm --filter @workspace/dashboard run dev"
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
echo Optional: SKIP_FREE_PORTS=1 — do not kill listeners on 3000/5173 before start.
echo.

popd
pause
endlocal
exit /b 0
