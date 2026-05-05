$ErrorActionPreference = "Continue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Manifest = Get-Content -Path (Join-Path $Root "engines\manifest.json") -Raw | ConvertFrom-Json
$InstallDir = Join-Path $Root $Manifest.installDir

function Test-CommandStatus($Name) {
  [pscustomobject]@{
    name = $Name
    ok = [bool](Get-Command $Name -ErrorAction SilentlyContinue)
  }
}

function Test-Http($Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return [pscustomobject]@{ ok = $true; status = [int]$response.StatusCode }
  } catch {
    return [pscustomobject]@{ ok = $false; status = $null; error = $_.Exception.Message }
  }
}

function Test-Port($Port) {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(700)
    if ($ok) { $client.EndConnect($async) }
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

$checks = @(
  Test-CommandStatus "git"
  Test-CommandStatus "node"
  Test-CommandStatus "npm"
  Test-CommandStatus $(if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { "python" })
)

Write-Host "Tool checks"
$checks | Format-Table -AutoSize

Write-Host "`nEngine checks"
foreach ($key in @("comfyui", "a1111")) {
  $engine = $Manifest.engines.$key
  $path = Join-Path $InstallDir $engine.directory
  $url = "$($engine.baseUrl)$($engine.healthPath)"
  [pscustomobject]@{
    engine = $key
    installed = Test-Path $path
    path = $path
    port = $engine.port
    portOpen = Test-Port $engine.port
    health = (Test-Http $url).ok
    healthUrl = $url
  } | Format-List
}

