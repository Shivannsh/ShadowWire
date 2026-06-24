#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$ROOT/.tools"
mkdir -p "$TOOLS_DIR"

export PATH="$TOOLS_DIR:$HOME/.cargo/bin:$PATH"

echo "==> Checking rustc..."
rustc --version
rustup target add wasm32-unknown-unknown

echo "==> Checking stellar-cli..."
if ! command -v stellar >/dev/null 2>&1; then
  cargo install --locked stellar-cli
fi
stellar --version

echo "==> Checking nargo..."
if [[ ! -x "$TOOLS_DIR/nargo" ]]; then
  ARCH="$(uname -m)"
  if [[ "$ARCH" == "arm64" ]]; then
    ASSET="nargo-aarch64-apple-darwin.tar.gz"
  else
    ASSET="nargo-x86_64-apple-darwin.tar.gz"
  fi
  URL=$(curl -sL "https://api.github.com/repos/noir-lang/noir/releases/latest" \
    | grep "browser_download_url.*${ASSET}" | head -1 | cut -d '"' -f 4)
  curl -sL "$URL" -o "$TOOLS_DIR/nargo.tar.gz"
  tar -xzf "$TOOLS_DIR/nargo.tar.gz" -C "$TOOLS_DIR"
  chmod +x "$TOOLS_DIR/nargo"
fi
"$TOOLS_DIR/nargo" --version

echo "==> Checking snarkjs..."
if ! command -v snarkjs >/dev/null 2>&1; then
  npm install -g snarkjs
fi
snarkjs --version

echo "Tools ready. Add to your shell:"
echo "export PATH=\"$TOOLS_DIR:\$PATH\""
