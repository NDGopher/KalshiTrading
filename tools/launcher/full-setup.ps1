#Requires -Version 5.1
<#
  One-shot: load repo .env → drizzle db:push → start API (3000) + Dashboard (5173) → PUT paper settings.
  Requires: C:\kalshitrading\.env with DATABASE_URL (and any Kalshi keys you already use).
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

function Import-RepoDotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  Get-Content $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -match "^\s*#" -or $line -eq "") { return }
    $ix = $line.IndexOf("=")
    if ($ix -lt 1) { return }
    $key = $line.Substring(0, $ix).Trim()
    $val = $line.Substring($ix + 1).Trim()
    if (
      ($val.Length -ge 2 -and $val.StartsWith([char]34) -and $val.EndsWith([char]34)) -or
      ($val.Length -ge 2 -and $val.StartsWith("'") -and $val.EndsWith("'"))
    ) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path "env:$key" -Value $val
  }
  return $true
}

$envFile = Join-Path $RepoRoot ".env"
if (-not (Import-RepoDotEnv -Path $envFile)) {
  Write-Host ""
  Write-Host "[ERROR] Missing $envFile" -ForegroundColor Red
  Write-Host "Create it with at least:" -ForegroundColor Yellow
  Write-Host '  DATABASE_URL=postgresql://USER:PASS@HOST:5432/DBNAME'
  Write-Host ""
  exit 1
}

if (-not $env:DATABASE_URL) {
  Write-Host "[ERROR] DATABASE_URL not set in .env" -ForegroundColor Red
  exit 1
}

Write-Host "`n[1/4] drizzle db:push (schema → Postgres)..." -ForegroundColor Cyan
pnpm --filter @workspace/db run db:push
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

Write-Host "`n[2/4] Starting API on PORT=3000 (new window)..." -ForegroundColor Cyan
$env:PORT = "3000"
Start-Process -FilePath $shell -WorkingDirectory $RepoRoot -ArgumentList @(
  "-NoExit", "-NoProfile", "-Command",
  "Set-Location '$RepoRoot'; `$env:PORT='3000'; pnpm --filter @workspace/api-server run dev"
)

Start-Sleep -Seconds 2

Write-Host "[3/4] Starting Dashboard on PORT=5173 BASE_PATH=/ (new window)..." -ForegroundColor Cyan
$env:PORT = "5173"
$env:BASE_PATH = "/"
Start-Process -FilePath $shell -WorkingDirectory $RepoRoot -ArgumentList @(
  "-NoExit", "-NoProfile", "-Command",
  "Set-Location '$RepoRoot'; `$env:PORT='5173'; `$env:BASE_PATH='/'; pnpm --filter @workspace/dashboard run dev"
)

$apiBase = if ($env:API_BASE_URL) { $env:API_BASE_URL.TrimEnd("/") } else { "http://127.0.0.1:3000" }
$healthUrl = "$apiBase/api/healthz"
$settingsUrl = "$apiBase/api/settings"

Write-Host "`n[4/4] Waiting for API ($healthUrl)..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 | Out-Null
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ok) {
  Write-Host "[WARN] API did not respond in time. Apply settings manually when it is up:" -ForegroundColor Yellow
  Write-Host "  PUT $settingsUrl" -ForegroundColor Gray
  Write-Host '  Body: {"paperTradingMode":true,"targetBetUsd":15,...}' -ForegroundColor Gray
  exit 0
}

$body = @{
  paperTradingMode  = $true
  targetBetUsd      = 15
  enabledStrategies = @("Whale Flow", "Volume Imbalance", "Dip Buy", "Pure Value")
  minEdge           = 6
  kellyFraction     = 0.5
} | ConvertTo-Json

try {
  $resp = Invoke-RestMethod -Uri $settingsUrl -Method Put -ContentType "application/json; charset=utf-8" -Body $body
  Write-Host "`nSettings applied OK." -ForegroundColor Green
  $resp | ConvertTo-Json -Depth 6
} catch {
  Write-Host "[WARN] PUT settings failed: $_" -ForegroundColor Yellow
  Write-Host "Apply manually in the UI: http://localhost:5173/settings" -ForegroundColor Yellow
}

Write-Host "`n--- Done ---" -ForegroundColor Cyan
Write-Host "Dashboard: http://localhost:5173/settings"
Write-Host "API:       $apiBase"
Write-Host "Optional:  double-click tools\launcher\run-backtest.bat for historical runs."
Write-Host ""
