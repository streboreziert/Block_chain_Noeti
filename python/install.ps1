# Install Noeti on Windows (PowerShell).
# Usage:  irm https://noeticompute.com/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Hub = if ($env:NOETIS_HUB) { $env:NOETIS_HUB } else { "https://noeticompute.com" }
$InstallRoot = if ($env:NOETIS_INSTALL_DIR) { $env:NOETIS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Noetis" }
$BinDir = Join-Path $InstallRoot "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$ZipUrl = "$Hub/downloads/noetis-windows-x86_64.zip"
$Tmp = Join-Path $env:TEMP "noetis-install"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Zip = Join-Path $Tmp "noetis.zip"

Write-Host "  Downloading Windows package…"
Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force

$Pkg = Get-ChildItem -Path $Tmp -Directory -Filter "Noetis" -Recurse | Select-Object -First 1
if (-not $Pkg) { throw "Package layout unexpected" }

Copy-Item -Path (Join-Path $Pkg.FullName "*") -Destination $InstallRoot -Recurse -Force
Get-ChildItem -Path (Join-Path $InstallRoot "bin") -Filter "noetis-*.exe" | ForEach-Object {
  Copy-Item $_.FullName -Destination (Join-Path $BinDir $_.Name) -Force
}

# Start Menu shortcut
$WshShell = New-Object -ComObject WScript.Shell
$StartMenu = [Environment]::GetFolderPath("StartMenu")
$Shortcut = $WshShell.CreateShortcut((Join-Path $StartMenu "Noeti.lnk"))
$startBat = Join-Path $InstallRoot "START Noeti.bat"
if (-not (Test-Path $startBat)) { $startBat = Join-Path $InstallRoot "START Noetis.bat" }
$Shortcut.TargetPath = $startBat
$Shortcut.WorkingDirectory = $InstallRoot
$Shortcut.Save()

Write-Host ""
Write-Host "  Installed to $InstallRoot"
Write-Host "  Start Menu → Noeti"
Write-Host "  Or double-click: $startBat"
Write-Host ""

& (Join-Path $BinDir "noetis-app.exe") --hub $Hub
