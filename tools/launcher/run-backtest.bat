@echo off
setlocal EnableExtensions
cd /d "%~dp0..\.."

if not exist "package.json" (
  echo [ERROR] Could not find package.json. Run this script from the repo; it lives in tools\launcher\.
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm is not on PATH. Install pnpm and retry.
  exit /b 1
)

echo.
echo === Kalshi historical multi-strategy backtest ===
echo.

set /p FROM="From date (YYYY-MM-DD): "
if "%FROM%"=="" (
  echo [ERROR] From date is required.
  exit /b 1
)

set /p TO="To date (YYYY-MM-DD, Enter = same as From): "
if "%TO%"=="" set "TO=%FROM%"

echo.
echo Sport filter:
echo   1  all markets
echo   2  Crypto + Other  ^(non-sports coarse bucket^)
echo   3  Sports-only
set /p SPORTCHOICE="Choose 1, 2, or 3 [1]: "
if "%SPORTCHOICE%"=="" set SPORTCHOICE=1

set "SPORT=all"
if "%SPORTCHOICE%"=="2" set "SPORT=CRYPTO+OTHER"
if "%SPORTCHOICE%"=="3" set "SPORT=Sports"

set /p STRATS="Strategies (comma-separated names, or all) [all]: "
if "%STRATS%"=="" set "STRATS=all"

set /p TBET="targetBetUsd [15]: "
if "%TBET%"=="" set "TBET=15"

echo.
echo Running: pnpm --filter @workspace/backtester run historical-multi -- --from %FROM% --to %TO% --sport "%SPORT%" --strategies "%STRATS%" --target-bet-usd %TBET% --bankroll 5000 --kelly
echo.

pnpm --filter @workspace/backtester run historical-multi -- --from "%FROM%" --to "%TO%" --sport "%SPORT%" --strategies "%STRATS%" --target-bet-usd %TBET% --bankroll 5000 --kelly
set RC=%ERRORLEVEL%

if not %RC%==0 (
  echo.
  echo [ERROR] Backtest exited with code %RC%.
  exit /b %RC%
)

set "JSON=%CD%\data\backtest-results\multi\last-partial-ranked.json"
set "CSV=%CD%\data\backtest-results\multi\last-partial-summary.csv"

echo.
if exist "%JSON%" (
  echo Opening %JSON%
  start "" "%JSON%"
) else (
  echo [WARN] Checkpoint JSON not found: %JSON%
)

if exist "%CSV%" (
  echo Opening %CSV%
  start "" "%CSV%"
) else (
  echo [WARN] Summary CSV not found: %CSV%
)

echo.
echo Done.
endlocal
exit /b 0
