#!/bin/sh
# kura インストーラ（ZIP 同梱）。KURA_INSTALL_DIR で展開先を上書き可
set -eu

BIN_DIR="${KURA_INSTALL_DIR:-$HOME/.local/bin}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/kura" "$BIN_DIR/kura"
chmod +x "$BIN_DIR/kura"

# macOS: Gatekeeper の quarantine 属性を除去
if [ "$(uname)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$BIN_DIR/kura" 2>/dev/null || true
  echo "note: macOS では Homebrew SQLite が必要です: brew install sqlite"
fi

echo "installed: $BIN_DIR/kura"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: PATH に $BIN_DIR を追加してください" ;;
esac
echo "next: kura init"
