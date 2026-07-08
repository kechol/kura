#!/bin/sh
# kura installer (bundled in the release ZIP). Override the install dir with KURA_INSTALL_DIR
set -eu

BIN_DIR="${KURA_INSTALL_DIR:-$HOME/.local/bin}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/kura" "$BIN_DIR/kura"
chmod +x "$BIN_DIR/kura"

# macOS: remove the Gatekeeper quarantine attribute
if [ "$(uname)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$BIN_DIR/kura" 2>/dev/null || true
  echo "note: kura requires Homebrew SQLite on macOS: brew install sqlite"
fi

echo "installed: $BIN_DIR/kura"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to your PATH" ;;
esac
echo "next: kura init"
