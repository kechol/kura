# kura インストーラ（Windows）。KURA_INSTALL_DIR で展開先を上書き可
$ErrorActionPreference = "Stop"

$dest = if ($env:KURA_INSTALL_DIR) { $env:KURA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "kura" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "kura.exe") (Join-Path $dest "kura.exe")

Write-Host "installed: $dest\kura.exe"
Write-Host "note: PATH に $dest を追加してください"
Write-Host "next: kura init"
