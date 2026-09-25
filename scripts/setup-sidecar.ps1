<#
.SYNOPSIS
    Create sidecar/.venv and install the Python AI sidecar's dependencies.

.PARAMETER NoTorch
    Skip PyTorch. The sidecar still runs and reports the GPU through nvidia-smi,
    but the local model provider stays unavailable.

.PARAMETER CudaIndex
    PyTorch wheel index to install from (cu126, cu128, cu130, ...).
#>
param(
    [switch]$NoTorch,
    [string]$CudaIndex = 'cu126'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecar = Join-Path $repoRoot 'sidecar'
$venv = Join-Path $sidecar '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

function Invoke-Checked {
    param([Parameter(Mandatory = $true)] [string]$Exe, [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path $python)) {
    Write-Host "Creating virtual environment in $venv" -ForegroundColor Cyan
    if (Get-Command py -ErrorAction SilentlyContinue) {
        Invoke-Checked py -3 -m venv $venv
    } else {
        Invoke-Checked python -m venv $venv
    }
}

Invoke-Checked $python -m pip install --upgrade pip
Invoke-Checked $python -m pip install -r (Join-Path $sidecar 'requirements.txt')

if (-not $NoTorch) {
    Write-Host "Installing PyTorch from the $CudaIndex wheel index" -ForegroundColor Cyan
    Invoke-Checked $python -m pip install torch --index-url "https://download.pytorch.org/whl/$CudaIndex"
}

Write-Host ""
Write-Host "Sidecar ready: $python" -ForegroundColor Green
