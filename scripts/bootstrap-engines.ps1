param(
  [switch]$ComfyOnly,
  [switch]$A1111Only,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ManifestPath = Join-Path $Root "engines\manifest.json"
$Manifest = Get-Content -Path $ManifestPath -Raw | ConvertFrom-Json
$InstallDir = Join-Path $Root $Manifest.installDir
$PythonExe = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { "python" }

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
    git -C $target fetch --all --prune
    git -C $target checkout $engine.branch
    git -C $target pull --ff-only
  } else {
    Write-Host "Cloning $($engine.name) -> $target"
    git clone --branch $engine.branch $engine.repoUrl $target
  }
  return $target
}

function Install-ComfyUI($Path) {
  if ($SkipInstall) { return }
  $venv = Join-Path $Path ".venv"
  if (-not (Test-Path $venv)) {
    & $PythonExe -m venv $venv
  }
  $python = Join-Path $venv "Scripts\python.exe"
  & $python -m pip install --upgrade pip
  & $python -m pip install -r (Join-Path $Path "requirements.txt")
}

function Install-A1111($Path) {
  if ($SkipInstall) { return }
  Write-Host "[A1111] Dependencies are installed by webui.bat on first start."
  Write-Host "[A1111] Path: $Path"
}

Assert-Command git
Assert-Command $PythonExe

$installComfy = (-not $A1111Only)
$installA1111 = (-not $ComfyOnly)

if ($installComfy) {
  $path = Sync-Repo "comfyui"
  Install-ComfyUI $path
}

if ($installA1111) {
  $path = Sync-Repo "a1111"
  Install-A1111 $path
}

Write-Host "Engine bootstrap complete."
Write-Host "Model weights are not downloaded. Place checkpoints in the engine model folders manually."

