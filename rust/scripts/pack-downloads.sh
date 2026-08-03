#!/usr/bin/env bash
# Pack launchable Noeti archives for macOS / Linux / Windows into html/downloads/
set -euo pipefail

RS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/Users/robertstreize/Desktop/BLOCKCHAIN_Noetis/html/downloads}"
mkdir -p "$OUT"
VERSION="$(grep -E 'CFBundleVersion|APP_VERSION' "$RS/crates/noetis-network/src/bin/app.rs" 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "0.5.8")"

# Hub /api/version prefers this file over NOETIS_APP_VERSION — keep in sync with packs.
echo "$VERSION" > "$OUT/VERSION"

# Prefer host release dir for native macOS pack
HOST_RELEASE="$RS/target/release"
HOST_ARCH="$(uname -m)"
CLIENT_SRC="$RS/crates/noetis-network/client"

copy_client_into() {
  local stage="$1"
  if [ -f "$CLIENT_SRC/app.html" ]; then
    mkdir -p "$stage/client"
    rsync -a --delete --exclude '.*' "$CLIENT_SRC/" "$stage/client/"
  else
    echo "WARN: no client/ at $CLIENT_SRC — UI updates will not ship in this pack"
  fi
}

pack_macos() {
  local name="$1"
  local srcdir="$2"
  local stage
  stage="$(mktemp -d)/Noetis"
  mkdir -p "$stage/bin"

  for b in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$srcdir/$b" ]; then
      cp "$srcdir/$b" "$stage/bin/"
      chmod +x "$stage/bin/$b"
    fi
  done
  [ -x "$stage/bin/noetis-app" ] || { echo "skip $name (missing noetis-app in $srcdir)"; rm -rf "$(dirname "$stage")"; return 0; }
  copy_client_into "$stage"
  echo "$VERSION" > "$stage/VERSION"

  cat > "$stage/START Noeti.command" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
HUB="${NOETIS_HUB:-https://noeticompute.com}"
export NOETIS_BIN_DIR="$(pwd)/bin"
export NOETIS_CLIENT_DIR="$(pwd)/client"
export PATH="$NOETIS_BIN_DIR:$PATH"
# Apply staged binary update (written while previous noetis-app was running)
if [ -d bin/.pending ]; then
  for f in bin/.pending/*; do
    [ -f "$f" ] || continue
    mv -f "$f" "bin/$(basename "$f")"
    chmod +x "bin/$(basename "$f")" 2>/dev/null || true
  done
  rmdir bin/.pending 2>/dev/null || rm -rf bin/.pending
fi
# Clear Gatekeeper quarantine (macOS) so compute registers on the hub
xattr -cr . 2>/dev/null || true
echo ""
echo "  Starting Noeti (macOS)…"
echo "  Browser opens → pick Chat or Earn."
echo ""
exec ./bin/noetis-app --hub "$HUB"
EOF
  chmod +x "$stage/START Noeti.command"
  cp "$stage/START Noeti.command" "$stage/START Noeti.sh"
  chmod +x "$stage/START Noeti.sh"

  cat > "$stage/README.txt" <<EOF
NOETI FOR macOS — one click
============================
App version: ${VERSION}

1. Double-click:  START Noeti.command
2. Browser opens → pick Chat or Earn
3. Progress bar installs Ollama + model automatically

Blocked by Gatekeeper?  Right-click → Open
Keep this folder; use Check for updates inside the app.

Phone chat: https://noeticompute.com/mobile/
EOF

  mkdir -p "$stage/Noetis.app/Contents/MacOS"
  cp "$stage/bin/noetis-app" "$stage/Noetis.app/Contents/MacOS/noetis-app"
  for b in noetis-compute noetis-hub noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$stage/bin/$b" ]; then
      cp "$stage/bin/$b" "$stage/Noetis.app/Contents/MacOS/"
      chmod +x "$stage/Noetis.app/Contents/MacOS/$b"
    fi
  done
  cat > "$stage/Noetis.app/Contents/MacOS/Noetis" <<'EOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
if [ -x "$DIR/noetis-compute" ]; then
  export NOETIS_BIN_DIR="$DIR"
elif [ -d "$ROOT/bin" ]; then
  export NOETIS_BIN_DIR="$ROOT/bin"
fi
export PATH="${NOETIS_BIN_DIR:-}:$PATH"
HUB="${NOETIS_HUB:-https://noeticompute.com}"
exec "$DIR/noetis-app" --hub "$HUB"
EOF
  chmod +x "$stage/Noetis.app/Contents/MacOS/"*
  cat > "$stage/Noetis.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Noetis</string>
  <key>CFBundleIdentifier</key><string>com.noetis.app</string>
  <key>CFBundleName</key><string>Noeti</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
</dict></plist>
PLIST

  (cd "$(dirname "$stage")" && zip -r -q "$OUT/${name}.zip" Noetis)
  (cd "$(dirname "$stage")" && tar -czf "$OUT/${name}.tar.gz" Noetis)
  echo "  OK $name"
  rm -rf "$(dirname "$stage")"
}

pack_linux() {
  local name="$1"
  local srcdir="$2"
  local stage
  stage="$(mktemp -d)/Noetis"
  mkdir -p "$stage/bin"

  for b in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$srcdir/$b" ]; then
      cp "$srcdir/$b" "$stage/bin/"
      chmod +x "$stage/bin/$b"
    fi
  done
  [ -x "$stage/bin/noetis-app" ] || { echo "skip $name (missing noetis-app in $srcdir)"; rm -rf "$(dirname "$stage")"; return 0; }
  copy_client_into "$stage"
  echo "$VERSION" > "$stage/VERSION"

  cat > "$stage/START Noeti.sh" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
HUB="${NOETIS_HUB:-https://noeticompute.com}"
export NOETIS_BIN_DIR="$(pwd)/bin"
export NOETIS_CLIENT_DIR="$(pwd)/client"
export PATH="$NOETIS_BIN_DIR:$PATH"
# Apply staged binary update (written while previous noetis-app was running)
if [ -d bin/.pending ]; then
  for f in bin/.pending/*; do
    [ -f "$f" ] || continue
    mv -f "$f" "bin/$(basename "$f")"
    chmod +x "bin/$(basename "$f")" 2>/dev/null || true
  done
  rmdir bin/.pending 2>/dev/null || rm -rf bin/.pending
fi
chmod +x bin/noetis-* 2>/dev/null || true
echo ""
echo "  Starting Noeti (Linux)…"
echo "  Browser opens → pick Chat or Earn."
echo ""
exec ./bin/noetis-app --hub "$HUB"
EOF
  chmod +x "$stage/START Noeti.sh"

  # Portable desktop entry — %k is this .desktop file’s path at runtime
  cat > "$stage/noetis.desktop" <<'EOF'
[Desktop Entry]
Name=Noeti
Comment=Decentralized AI compute + MLC wallet
Exec=bash -c 'DIR="$(dirname "$(readlink -f "%k")")"; cd "$DIR"; export NOETIS_BIN_DIR="$DIR/bin"; export PATH="$NOETIS_BIN_DIR:$PATH"; exec "$DIR/bin/noetis-app" --hub "${NOETIS_HUB:-https://noeticompute.com}"'
Terminal=false
Type=Application
Categories=Network;Utility;
EOF

  cat > "$stage/README.txt" <<EOF
NOETI FOR LINUX — one click
============================
App version: ${VERSION}

1. chmod +x "START Noeti.sh" bin/*
2. Run:  ./START\ Noeti.sh
   Or double-click START Noeti.sh / noetis.desktop

3. Browser opens → pick Chat or Earn

Need unzip for updates:  sudo apt install unzip   (or use tar.gz)

Phone chat: https://noeticompute.com/mobile/
EOF

  (cd "$(dirname "$stage")" && zip -r -q "$OUT/${name}.zip" Noetis)
  (cd "$(dirname "$stage")" && tar -czf "$OUT/${name}.tar.gz" Noetis)
  echo "  OK $name"
  rm -rf "$(dirname "$stage")"
}

pack_windows() {
  local srcdir=""
  for candidate in \
    "$RS/target/x86_64-pc-windows-gnu/release" \
    "$RS/target/x86_64-pc-windows-msvc/release" \
    "${1:-}"; do
    if [ -n "${candidate:-}" ] && [ -f "$candidate/noetis-app.exe" ]; then
      srcdir="$candidate"
      break
    fi
  done
  if [ -z "$srcdir" ]; then
    echo "skip noetis-windows-x86_64 (no Windows build found)"
    return 0
  fi

  local stage
  stage="$(mktemp -d)/Noetis"
  mkdir -p "$stage/bin"

  for b in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$srcdir/$b.exe" ]; then
      cp "$srcdir/$b.exe" "$stage/bin/"
    fi
  done
  [ -f "$stage/bin/noetis-app.exe" ] || { echo "missing noetis-app.exe"; rm -rf "$(dirname "$stage")"; return 1; }
  copy_client_into "$stage"
  echo "$VERSION" > "$stage/VERSION"

  cat > "$stage/START Noeti.bat" <<'EOF'
@echo off
cd /d "%~dp0"
set NOETIS_BIN_DIR=%~dp0bin
set NOETIS_CLIENT_DIR=%~dp0client
set PATH=%NOETIS_BIN_DIR%;%PATH%
set HUB=https://noeticompute.com
if defined NOETIS_HUB set HUB=%NOETIS_HUB%

REM Apply staged binary update (written while previous noetis-app was running)
if exist "bin\.pending\" (
  echo Applying update...
  for %%F in ("bin\.pending\*") do (
    if exist "%%~fF" move /Y "%%~fF" "bin\" >nul
  )
  rmdir /s /q "bin\.pending" 2>nul
)

echo.
echo   Starting Noeti (Windows)...
echo   Browser opens - pick Chat or Earn.
echo.
bin\noetis-app.exe --hub %HUB%
if errorlevel 1 pause
EOF

  cat > "$stage/START Noeti.ps1" <<'EOF'
$Hub = if ($env:NOETIS_HUB) { $env:NOETIS_HUB } else { "https://noeticompute.com" }
Set-Location $PSScriptRoot
$env:NOETIS_BIN_DIR = Join-Path $PSScriptRoot "bin"
$env:NOETIS_CLIENT_DIR = Join-Path $PSScriptRoot "client"
$env:PATH = "$($env:NOETIS_BIN_DIR);$($env:PATH)"
$pending = Join-Path $env:NOETIS_BIN_DIR ".pending"
if (Test-Path $pending) {
  Write-Host "Applying update..."
  Get-ChildItem -Path $pending -File | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $env:NOETIS_BIN_DIR -Force
  }
  Remove-Item -Recurse -Force $pending -ErrorAction SilentlyContinue
}
Write-Host "Starting Noeti (Windows)... pick Chat or Earn in the browser."
& .\bin\noetis-app.exe --hub $Hub
EOF

  cat > "$stage/README.txt" <<EOF
NOETI FOR WINDOWS — one click
==============================
App version: ${VERSION}

1. Double-click:  START Noeti.bat
2. Browser opens → pick Chat or Earn
3. Progress bar installs Ollama + model automatically

SmartScreen?  More info → Run anyway
After Check for updates: quit and run START Noeti.bat again.

Phone chat: https://noeticompute.com/mobile/
EOF

  (cd "$(dirname "$stage")" && zip -r -q "$OUT/noetis-windows-x86_64.zip" Noetis)
  echo "  OK noetis-windows-x86_64 (from $srcdir)"
  rm -rf "$(dirname "$stage")"
}

echo "Packaging into $OUT (version hint ${VERSION})"

# macOS — pack native host build under correct arch name
if [ -x "$HOST_RELEASE/noetis-app" ]; then
  if [ "$HOST_ARCH" = "arm64" ] || [ "$HOST_ARCH" = "aarch64" ]; then
    pack_macos noetis-macos-aarch64 "$HOST_RELEASE"
  else
    pack_macos noetis-macos-x86_64 "$HOST_RELEASE"
  fi
fi
# Cross / secondary mac targets
if [ -x "$RS/target/aarch64-apple-darwin/release/noetis-app" ]; then
  pack_macos noetis-macos-aarch64 "$RS/target/aarch64-apple-darwin/release"
fi
if [ -x "$RS/target/x86_64-apple-darwin/release/noetis-app" ]; then
  pack_macos noetis-macos-x86_64 "$RS/target/x86_64-apple-darwin/release"
fi

pack_windows

# Linux
if [ -x "$RS/target/x86_64-unknown-linux-gnu/release/noetis-app" ]; then
  pack_linux noetis-linux-x86_64 "$RS/target/x86_64-unknown-linux-gnu/release"
fi
if [ -x "$RS/target/aarch64-unknown-linux-gnu/release/noetis-app" ]; then
  pack_linux noetis-linux-aarch64 "$RS/target/aarch64-unknown-linux-gnu/release"
fi
# Native Linux host
if [ "$(uname -s)" = "Linux" ] && [ -x "$HOST_RELEASE/noetis-app" ]; then
  if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
    pack_linux noetis-linux-aarch64 "$HOST_RELEASE"
  else
    pack_linux noetis-linux-x86_64 "$HOST_RELEASE"
  fi
fi

# Phone helper zip
phone="$(mktemp -d)/Noetis-Phone"
mkdir -p "$phone"
cat > "$phone/Open Noeti.html" <<'EOF'
<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta http-equiv="refresh" content="0;url=https://noeticompute.com/mobile/"/>
<title>Open Noeti</title>
</head><body style="font-family:sans-serif;background:#030806;color:#c8ffd8;padding:40px">
<p>Opening Noeti…</p>
<p><a href="https://noeticompute.com/mobile/" style="color:#00ff88">Tap here if nothing happens</a></p>
<p>Then: browser menu → <b>Add to Home Screen</b></p>
</body></html>
EOF
cat > "$phone/README.txt" <<'EOF'
PHONE / TABLET (chat only)
==========================
1. Open https://noeticompute.com/mobile/
2. Add to Home Screen
Earn/compute needs the desktop zip for your OS (macOS / Windows / Linux).
EOF
(cd "$(dirname "$phone")" && zip -r -q "$OUT/noetis-phone-pwa.zip" Noetis-Phone)
rm -rf "$(dirname "$phone")"

echo ""
echo "Packs present:"
ls -lh "$OUT"/noetis-*.zip 2>/dev/null || true
for need in noetis-macos-aarch64.zip noetis-macos-x86_64.zip noetis-windows-x86_64.zip noetis-linux-x86_64.zip noetis-linux-aarch64.zip; do
  if [ ! -f "$OUT/$need" ]; then
    echo "  WARN missing $need — build that target before deploy so downloads don’t 404"
  fi
done
echo "$VERSION" > "$OUT/VERSION"
echo "Wrote $OUT/VERSION = $VERSION"
echo "Done."
