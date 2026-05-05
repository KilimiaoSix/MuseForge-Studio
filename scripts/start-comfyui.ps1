param(
  [int]$Port = 8188,
  [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnginePath = Join-Path $Root "vendor\engines\ComfyUI"
$Python = Join-Path $EnginePath ".venv\Scripts\python.exe"

if (-not (Test-Path $EnginePath)) {
  throw "ComfyUI is not installed. Run scripts/bootstrap-engines.ps1 first."
}

if (-not (Test-Path $Python)) {
  throw "ComfyUI venv not found. Run scripts/bootstrap-engines.ps1 first."
}

Push-Location $EnginePath
try {
  & $Python "main.py" --listen $HostAddress --port $Port
} finally {
  Pop-Location
}

