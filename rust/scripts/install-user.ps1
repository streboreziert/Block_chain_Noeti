# Install Noetis on Windows (PowerShell).
# Usage:  irm https://noeticompute.com/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "streboreziert/Block_chain_Noeti"
$Hub = if ($env:NOETIS_HUB) { $env:NOETIS_HUB } else { "https://noeticompute.com" }
$InstallDir = if ($env:NOETIS_INSTALL_DIR) { $env:NOETIS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Noetis\bin" }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$Asset = "noetis-windows-x86_64.zip"
$Url = "https://github.com/$Repo/releases/latest/download/$Asset"
$Tmp = Join-Path $env:TEMP "noetis-install"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Zip = Join-Path $Tmp $Asset

Write-Host "  Downloading $Asset…"
try {
  Invoke-WebRequest -Uri $Url -OutFile $Zip
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  Get-ChildItem -Path $Tmp -Recurse -Filter "noetis-*.exe" | ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $InstallDir $_.Name) -Force
  }
} catch {
  Write-Host "  Release not available yet. Install Rust + clone main, then:"
  Write-Host "    cargo build --release -p noetis-network"
  exit 1
}

# Start Menu shortcut
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("StartMenu")) "Noetis.lnk"))
$Shortcut.TargetPath = Join-Path $InstallDir "noetis-app.exe"
$Shortcut.Arguments = "--hub $Hub"
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Save()

Write-Host ""
Write-Host "  Installed to $InstallDir"
Write-Host "  Added Start Menu → Noetis"
Write-Host ""
Write-Host "  Run:  & '$InstallDir\noetis-app.exe' --hub $Hub"
Write-Host ""

& (Join-Path $InstallDir "noetis-app.exe") --hub $Hub
