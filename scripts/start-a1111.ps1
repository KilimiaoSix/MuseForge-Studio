param(
  [int]$Port = 7860
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnginePath = Join-Path $Root "vendor\engines\stable-diffusion-webui"
$WebuiBat = Join-Path $EnginePath "webui.bat"
$PortablePython = Join-Path $EnginePath "python\python.exe"
$LaunchPy = Join-Path $EnginePath "launch.py"

if (-not (Test-Path $WebuiBat)) {
  throw "A1111 WebUI is not installed. Run scripts/bootstrap-engines.ps1 first or copy it to vendor\engines\stable-diffusion-webui."
}

Push-Location $EnginePath
try {
  $env:SKIP_ASSETS_UPDATE = "1"

  if ((Test-Path $PortablePython) -and (Test-Path $LaunchPy)) {
    & $PortablePython "launch.py" --api --listen --port $Port --skip-python-version-check --skip-install
  } else {
    & $WebuiBat --api --listen --port $Port --skip-install
  }
} finally {
  Pop-Location
}
