param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ManifestPath = Join-Path $Root "engines\manifest.json"
$Manifest = Get-Content -Path $ManifestPath -Raw | ConvertFrom-Json
$InstallDir = Join-Path $Root $Manifest.installDir

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Sync-Repo($EngineKey) {
  $engine = $Manifest.engines.$EngineKey
  $target = Join-Path $InstallDir $engine.directory
  if (Test-Path $target) {
    Write-Host "[$($engine.name)] already exists: $target"
    if (Test-Path (Join-Path $target ".git")) {
      git -C $target fetch --all --prune
      git -C $target checkout $engine.branch
      git -C $target pull --ff-only
    }
  } else {
    Write-Host "Cloning $($engine.name) -> $target"
    git clone --branch $engine.branch $engine.repoUrl $target
  }
  return $target
}

function Install-A1111($Path) {
  if ($SkipInstall) { return }
  Write-Host "[A1111] Dependencies are installed by webui.bat on first start."
  Write-Host "[A1111] Path: $Path"
}

Assert-Command git

$path = Sync-Repo "a1111"
Install-A1111 $path

Write-Host "A1111 bootstrap complete."
Write-Host "Model weights are not downloaded. Place checkpoints in vendor\engines\stable-diffusion-webui\models\Stable-diffusion manually."
