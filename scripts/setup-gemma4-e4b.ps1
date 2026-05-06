param(
  [switch]$SkipInstall,
  [switch]$SkipPull
)

$ErrorActionPreference = "Stop"
$Model = "gemma4:e4b"
$BaseUrl = "http://127.0.0.1:11434"

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-Ollama {
  if ($SkipInstall) {
    throw "Ollama is not installed and -SkipInstall was provided."
  }

  if (-not (Test-Command "winget")) {
    throw "Ollama is not installed and winget is not available. Install Ollama from https://ollama.com/download/windows, then rerun this script."
  }

  Write-Host "Installing Ollama with winget..."
  winget install --id Ollama.Ollama --source winget --accept-package-agreements --accept-source-agreements
}

function Wait-Ollama {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri "$BaseUrl/api/version" -TimeoutSec 3 | Out-Null
      return
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "Ollama service did not respond at $BaseUrl."
}

if (-not (Test-Command "ollama")) {
  Install-Ollama
}

Write-Host "Starting Ollama service if needed..."
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
Wait-Ollama

if (-not $SkipPull) {
  Write-Host "Pulling $Model..."
  ollama pull $Model
}

Write-Host "Validating OpenAI-compatible chat endpoint..."
$payload = @{
  model = $Model
  messages = @(
    @{ role = "user"; content = "Reply with exactly: ok" }
  )
  stream = $false
} | ConvertTo-Json -Depth 6

$response = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 120

[pscustomobject]@{
  ok = $true
  model = $Model
  baseUrl = "$BaseUrl/v1"
  response = $response.choices[0].message.content
} | ConvertTo-Json -Depth 6
