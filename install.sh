#!/usr/bin/env bash
# install.sh — link nk into ~/.local/bin and enable completion. Safe to re-run.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN="$HOME/.local/bin"

mkdir -p "$BIN" "${XDG_CONFIG_HOME:-$HOME/.config}/nk/stacks"
chmod +x "$ROOT/bin/nk"
ln -sfn "$ROOT/bin/nk" "$BIN/nk"
echo "✓ linked $BIN/nk -> $ROOT/bin/nk"

LINE=". $ROOT/completion.bash"
if ! grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# nk completion\n%s\n' "$LINE" >> "$HOME/.bashrc"
  echo "✓ added nk completion to ~/.bashrc"
else
  echo "· nk completion already in ~/.bashrc"
fi

case ":$PATH:" in
  *":$BIN:"*) echo "✓ $BIN อยู่ใน PATH แล้ว" ;;
  *) echo "! เพิ่มบรรทัดนี้ใน ~/.bashrc:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo
echo "เปิด shell ใหม่ (หรือ: exec bash) แล้วลอง:  nk status"
