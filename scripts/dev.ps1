<#
.SYNOPSIS
    Run Oisín for development.

.DESCRIPTION
    By default starts the Electron app in dev mode; the app launches the Python
    sidecar itself. -SidecarOnly runs just the sidecar on a fixed port with a
    printed token, for exercising the API by hand.
#>
param(
    [switch]$SidecarOnly,
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'app'
$sidecarDir = Join-Path $repoRoot 'sidecar'
$python = Join-Path $sidecarDir '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    throw "Sidecar environment missing. Run scripts\setup-sidecar.ps1 first."
}

if ($SidecarOnly) {
    Push-Location $sidecarDir
    try { & $python -m oisin_ai --port $Port } finally { Pop-Location }
    return
}

Push-Location $appDir
try {
    if (-not (Test-Path (Join-Path $appDir 'node_modules'))) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    npm run dev
} finally {
    Pop-Location
}
