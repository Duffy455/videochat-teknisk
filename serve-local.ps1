$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "Kjor 'npm install' forst."
  exit 1
}

node server.js
