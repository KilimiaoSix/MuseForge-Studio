param(
  [int]$Port = 7860
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnginePath = Join-Path $Root "vendor\engines\stable-diffusion-webui"
$WebuiBat = Join-Path $EnginePath "webui.bat"

if (-not (Test-Path $WebuiBat)) {
  throw "A1111 WebUI is not installed. Run scripts/bootstrap-engines.ps1 first."
}

Push-Location $EnginePath
try {
  & $WebuiBat --api --listen --port $Port
} finally {
  Pop-Location
}

