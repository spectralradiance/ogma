<#
Starts the Ogma API and frontend dev servers together, each in its own
console window, so you can watch/close them independently.
#>

$root = Split-Path -Parent $PSScriptRoot

Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root'; .\.venv\Scripts\python.exe -m uvicorn api.main:app --reload --port 8000"
) -WindowStyle Normal

Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root\frontend'; npm run dev"
) -WindowStyle Normal

Write-Host "Started the API (http://localhost:8000) and frontend (Vite) in separate windows."
Write-Host "Close either window, or Ctrl+C inside it, to stop that server."
