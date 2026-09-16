#!/usr/bin/env bash
# install.sh — link nk into ~/.local/bin and enable completion. Safe to re-run.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BIN="$HOME/.local/bin"

STACKS="${NK_STACKS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/nk/stacks}"
mkdir -p "$BIN" "$STACKS"

# First install: seed the example stacks. Never overwrite what is already there.
for f in "$ROOT"/examples/*.sh; do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  [ -e "$STACKS/$b" ] || { cp "$f" "$STACKS/$b"; echo "✓ seeded $STACKS/$b"; }
done
chmod +x "$ROOT/bin/nk" "$ROOT/bin/d3v"
ln -sfn "$ROOT/bin/nk" "$BIN/nk"
ln -sfn "$ROOT/bin/d3v" "$BIN/d3v"
echo "✓ linked $BIN/nk and $BIN/d3v"

LINE=". $ROOT/completion.bash"
if ! grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# nk completion\n%s\n' "$LINE" >> "$HOME/.bashrc"
  echo "✓ added nk completion to ~/.bashrc"
else
  echo "· nk completion already in ~/.bashrc"
fi

# ~/.profile already adds ~/.local/bin, but only for login shells — WSL
# terminals here start interactive non-login, so put it in ~/.bashrc too.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
if ! grep -qF "$PATH_LINE" "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# ~/.local/bin (nk)\n%s\n' "$PATH_LINE" >> "$HOME/.bashrc"
  echo "✓ added $BIN to PATH in ~/.bashrc"
else
  echo "· $BIN already on PATH in ~/.bashrc"
fi

echo
echo "เปิด shell ใหม่ (หรือ: exec bash) แล้วลอง:  nk status"
