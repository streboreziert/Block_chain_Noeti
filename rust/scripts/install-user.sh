#!/usr/bin/env bash
# Install Noetis desktop tools for macOS / Linux.
# Usage:  curl -sSL https://noeticompute.com/install.sh | bash
set -euo pipefail

REPO="streboreziert/Block_chain_Noeti"
HUB="${NOETIS_HUB:-https://noeticompute.com}"
INSTALL_DIR="${NOETIS_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "Unsupported arch: $arch"; exit 1 ;;
esac

case "$os" in
  darwin) asset="noetis-macos-${arch}.tar.gz" ;;
  linux)  asset="noetis-linux-${arch}.tar.gz" ;;
  *) echo "Unsupported OS: $os (use install.ps1 on Windows)"; exit 1 ;;
esac

url="https://github.com/${REPO}/releases/latest/download/${asset}"
tmp="$(mktemp -d)"
echo "  Downloading ${asset}…"
if ! curl -fsSL "$url" -o "$tmp/$asset"; then
  echo "  Release asset not published yet — building from source (needs Rust)…"
  command -v cargo >/dev/null || { echo "Install Rust from https://rustup.rs"; exit 1; }
  git clone --depth 1 -b main "https://github.com/${REPO}.git" "$tmp/src"
  (cd "$tmp/src" && cargo build --release -p noetis-network)
  for bin in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    cp "$tmp/src/target/release/$bin" "$INSTALL_DIR/" 2>/dev/null || true
  done
else
  tar -xzf "$tmp/$asset" -C "$tmp"
  find "$tmp" -type f -perm -u+x -maxdepth 3 | while read -r f; do
    base="$(basename "$f")"
    case "$base" in noetis-*) cp "$f" "$INSTALL_DIR/$base" ;; esac
  done
  # also copy non-executable that lost +x
  for bin in noetis-app noetis-hub noetis-compute noetis-relay noetis-sync noetis-wallet; do
    if [ -f "$tmp/$bin" ]; then cp "$tmp/$bin" "$INSTALL_DIR/$bin"; chmod +x "$INSTALL_DIR/$bin"; fi
    if [ -f "$tmp/bin/$bin" ]; then cp "$tmp/bin/$bin" "$INSTALL_DIR/$bin"; chmod +x "$INSTALL_DIR/$bin"; fi
  done
fi

# Desktop launcher (Linux)
if [ "$os" = "linux" ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/noetis.desktop" <<EOF
[Desktop Entry]
Name=Noetis
Comment=Decentralized AI + MLC wallet
Exec=$INSTALL_DIR/noetis-app --hub $HUB
Icon=utilities-terminal
Terminal=false
Type=Application
Categories=Network;Utility;
EOF
fi

# macOS double-click launcher
if [ "$os" = "darwin" ]; then
  app_dir="$HOME/Applications/Noetis.app/Contents/MacOS"
  mkdir -p "$app_dir"
  cat > "$app_dir/Noetis" <<EOF
#!/bin/bash
exec "$INSTALL_DIR/noetis-app" --hub "$HUB"
EOF
  chmod +x "$app_dir/Noetis"
  cat > "$HOME/Applications/Noetis.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Noetis</string>
  <key>CFBundleIdentifier</key><string>com.noetis.app</string>
  <key>CFBundleName</key><string>Noetis</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
fi

echo ""
echo "  Installed to $INSTALL_DIR"
echo "  Ensure it is on PATH:  export PATH=\"\$PATH:$INSTALL_DIR\""
echo ""
echo "  Start the user app (wallet + chat):"
echo "    $INSTALL_DIR/noetis-app --hub $HUB"
echo ""
echo "  Earn MLC (needs Ollama):"
echo "    $INSTALL_DIR/noetis-compute --hub $HUB --id my-node"
echo ""

if [ -t 0 ]; then
  read -r -p "  Launch Noetis app now? [Y/n] " answer
  case "${answer:-Y}" in
    [Yy]*) exec "$INSTALL_DIR/noetis-app" --hub "$HUB" ;;
  esac
fi
