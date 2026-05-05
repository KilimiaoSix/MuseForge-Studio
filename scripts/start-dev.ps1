param(
  [ValidateSet("comfyui", "a1111")]
  [string]$Engine = $(if ($env:INFERENCE_BACKEND) { $env:INFERENCE_BACKEND } else { "comfyui" })
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Start-HiddenPowerShell($Name, $Command) {
  Write-Host "Starting $Name..."
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", $Command
  ) | Out-Null
}

if ($Engine -eq "comfyui") {
  Start-HiddenPowerShell "ComfyUI" "cd '$Root'; .\scripts\start-comfyui.ps1"
} else {
  Start-HiddenPowerShell "A1111 WebUI" "cd '$Root'; .\scripts\start-a1111.ps1"
}

Start-HiddenPowerShell "SD Agent Backend" "cd '$Root'; `$env:INFERENCE_BACKEND='$Engine'; npm run dev:backend"
Start-HiddenPowerShell "SD Agent UI Prototype" "cd '$Root'; npm run dev:ui"

Write-Host "Dev stack starting."
Write-Host "Backend: http://127.0.0.1:8787"
Write-Host "UI:      http://127.0.0.1:5177"
Write-Host "Engine:  $Engine"

