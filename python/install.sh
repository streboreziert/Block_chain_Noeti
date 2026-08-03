#!/usr/bin/env bash
# Install Noetis for macOS / Linux — auto-detects your CPU.
# Usage:  curl -sSL https://noeticompute.com/install.sh | bash
set -euo pipefail

HUB="${NOETIS_HUB:-https://noeticompute.com}"
INSTALL_DIR="${NOETIS_INSTALL_DIR:-$HOME/.local/bin}"
APP_HOME="${NOETIS_APP_HOME:-$HOME/Applications/Noetis}"
mkdir -p "$INSTALL_DIR"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "Unsupported CPU: $arch"; exit 1 ;;
esac

if [ "$os" = "darwin" ]; then
  asset="noetis-macos-${arch}.zip"
elif [ "$os" = "linux" ]; then
  asset="noetis-linux-${arch}.zip"
else
  echo "This script is for macOS/Linux."
  echo "Windows: irm ${HUB}/install.ps1 | iex"
  echo "Phone:   open ${HUB}/mobile/"
  exit 1
fi

tmp="$(mktemp -d)"
url="${HUB}/downloads/${asset}"
echo "  Downloading ${asset}…"

if ! curl -fsSL "$url" -o "$tmp/pkg.zip"; then
  echo "  Package not on server yet — building from source (needs Rust)…"
  command -v cargo >/dev/null || { echo "Install Rust: https://rustup.rs"; exit 1; }
  command -v git >/dev/null || { echo "Install git first."; exit 1; }
  git clone --depth 1 -b main "https://github.com/streboreziert/Block_chain_Noeti.git" "$tmp/src"
  (cd "$tmp/src/rust" && cargo build --release -p noetis-network)
  for bin in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    cp "$tmp/src/target/release/$bin" "$INSTALL_DIR/$bin"
    chmod +x "$INSTALL_DIR/$bin"
  done
else
  if command -v unzip >/dev/null; then
    unzip -q "$tmp/pkg.zip" -d "$tmp/out"
  else
    mkdir -p "$tmp/out"
    tar -xf "$tmp/pkg.zip" -C "$tmp/out"
  fi
  pkg="$(find "$tmp/out" -maxdepth 2 -type d -name Noetis | head -1)"
  [ -n "$pkg" ] || pkg="$tmp/out"
  mkdir -p "$APP_HOME"
  rm -rf "${APP_HOME:?}/"*
  cp -R "$pkg"/* "$APP_HOME/" 2>/dev/null || true
  for bin in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$pkg/bin/$bin" ]; then
      cp "$pkg/bin/$bin" "$INSTALL_DIR/$bin"
      chmod +x "$INSTALL_DIR/$bin"
    fi
  done
  if [ "$os" = "darwin" ] && [ -d "$pkg/Noetis.app" ]; then
    rm -rf "$HOME/Applications/Noetis.app"
    cp -R "$pkg/Noetis.app" "$HOME/Applications/Noetis.app"
  fi
  if [ "$os" = "linux" ]; then
    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/noetis.desktop" <<DESK
[Desktop Entry]
Name=Noeti
Comment=Decentralized AI compute + MLC wallet
Exec=$INSTALL_DIR/noetis-app --hub $HUB
Terminal=false
Type=Application
Categories=Network;Utility;
DESK
  fi
fi

echo ""
echo "  Installed CLI: $INSTALL_DIR/noetis-app"
if [ -d "$APP_HOME" ]; then echo "  App folder:    $APP_HOME"; fi
if [ -d "$HOME/Applications/Noetis.app" ]; then echo "  macOS app:     ~/Applications/Noetis.app"; fi
echo ""
echo "  Launching Noeti…"
exec "$INSTALL_DIR/noetis-app" --hub "$HUB"
