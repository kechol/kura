# kura installer (Windows). Override the install dir with KURA_INSTALL_DIR
$ErrorActionPreference = "Stop"

$dest = if ($env:KURA_INSTALL_DIR) { $env:KURA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "kura" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "kura.exe") (Join-Path $dest "kura.exe")

Write-Host "installed: $dest\kura.exe"
Write-Host "note: add $dest to your PATH"
Write-Host "next: kura init"
