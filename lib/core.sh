# shellcheck shell=bash
# core.sh — shared helpers for nk. Sourced by bin/nk, never run directly.

NK_ROOT="${NK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NK_HOME="${NK_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/nk}"
NK_PREFIX="nk-"

# ---------------------------------------------------------------- output ----
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_RED=; C_GRN=; C_YEL=; C_BLU=; C_DIM=; C_B=; C_0=
fi

info() { printf '%s==>%s %s\n' "$C_BLU" "$C_0" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GRN" "$C_0" "$*"; }
warn() { printf '%s  !%s %s\n' "$C_YEL" "$C_0" "$*" >&2; }
die()  { printf '%s  ✗%s %s\n' "$C_RED" "$C_0" "$*" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_0"; }

# --------------------------------------------------------- stack lookup ----
#
# Every stack is one shell file in a single directory. No layering, no
# overrides: what you see in `nk list` is exactly what is in that folder.
NK_STACKS_DIR="${NK_STACKS_DIR:-$NK_HOME/stacks}"
NK_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/nk"

# A stack may keep a sudo password so its panes can answer sudo without anyone
# watching. It lives outside the stack file — that file is meant to be readable
# and shareable — in its own 0600 file.
NK_SECRETS_DIR="${NK_SECRETS_DIR:-$NK_HOME/secrets}"
nk_secret_file() { printf '%s' "$NK_SECRETS_DIR/$1.pw"; }
nk_has_secret()  { [ -s "$(nk_secret_file "$1")" ]; }

nk_stack_file() { printf '%s' "$NK_STACKS_DIR/$1.sh"; [ -f "$NK_STACKS_DIR/$1.sh" ]; }

# nk_stacks — every stack name, sorted.
nk_stacks() {
  local f
  for f in "$NK_STACKS_DIR"/*.sh; do
    [ -e "$f" ] || continue
    basename "$f" .sh
  done
}

# nk_load <stack> — source a stack definition into the current shell. Clears
# the NK_* contract first so one load cannot leak into the next.
nk_load() {
  local name=$1 file
  file=$(nk_stack_file "$name") ||
    die "ไม่รู้จัก stack '$name' (ดูรายการด้วย: nk list)"

  NK_NAME=$name NK_DIR= NK_PORTS= NK_URL= NK_ENV_FILE= NK_NOTE=
  NK_API_BASE= NK_TOKEN_CMD= NK_FILE=$file
  NK_PANES=()

  # shellcheck disable=SC1090
  . "$file"

  NK_DIR="${NK_DIR/#\~/$HOME}"
  [ -n "$NK_DIR" ]          || die "$name: ไม่ได้ตั้ง NK_DIR ($file)"
  [ -d "$NK_DIR" ]          || die "$name: ไม่มีไดเรกทอรี $NK_DIR ($file)"
  [ ${#NK_PANES[@]} -gt 0 ] || die "$name: ไม่ได้ตั้ง NK_PANES ($file)"
}

# nk_resolve_stack — the stack that token/curl/mk act on: an explicit name,
# else $NK_STACK, else the one stack whose NK_DIR contains the current directory.
nk_resolve_stack() {
  [ -n "${1:-}" ] && { printf '%s' "$1"; return 0; }
  [ -n "${NK_STACK:-}" ] && { printf '%s' "$NK_STACK"; return 0; }
  local name here=$PWD hits= n=0
  for name in $(nk_stacks); do
    ( nk_load "$name" >/dev/null 2>&1 || exit 1
      case "$here/" in "$NK_DIR"/*) exit 0 ;; esac; exit 1 ) && { hits=$name; n=$((n+1)); }
  done
  [ "$n" = 1 ] && { printf '%s' "$hits"; return 0; }
  return 1
}

nk_session() { printf '%s%s' "$NK_PREFIX" "$1"; }

# ------------------------------------------------------------------ ports ----

# nk_port_pids <port> — pids listening on the port, ours first then root-owned.
nk_port_pids() {
  local port=$1 pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  # lsof only sees our own processes. Before asking sudo, check with ss whether
  # anything is bound at all: `nk status` runs this for every declared port
  # every few seconds, and a `sudo -n` that fails writes to the auth log each
  # time. A free port never reaches sudo.
  if [ -z "$pids" ] && command -v sudo >/dev/null && nk_port_bound "$port"; then
    pids=$(sudo -n lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  fi
  printf '%s' "$pids"
}

# nk_port_bound <port> — true if some process (anyone's) listens on the port.
# Without ss we cannot tell, so assume it might be and let the caller try sudo.
nk_port_bound() {
  command -v ss >/dev/null || return 0
  [ -n "$(ss -Hltn "( sport = :$1 )" 2>/dev/null)" ]
}

nk_pid_name() { ps -p "$1" -o comm= 2>/dev/null || echo '?'; }

# nk_free_port <port> — TERM then KILL whatever listens on the port. This is
# the whole reason nk exists: ~101 lsof/kill -9 rounds in the shell history.
nk_free_port() {
  local port=$1 pids pid n
  pids=$(nk_port_pids "$port")
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    n=$(nk_pid_name "$pid")
    info "port $port ถูกจับโดย $n (pid $pid) — กำลังปิด"
    kill -TERM "$pid" 2>/dev/null || sudo -n kill -TERM "$pid" 2>/dev/null || true
  done

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    [ -n "$(nk_port_pids "$port")" ] || { ok "port $port ว่างแล้ว"; return 0; }
  done

  for pid in $(nk_port_pids "$port"); do
    warn "pid $pid ไม่ยอมจบ — kill -9"
    kill -9 "$pid" 2>/dev/null || sudo -n kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.3

  [ -z "$(nk_port_pids "$port")" ] || die "เคลียร์ port $port ไม่สำเร็จ (ลอง: sudo nk kill $port)"
  ok "port $port ว่างแล้ว"
}

nk_free_ports() { local p; for p in $NK_PORTS; do nk_free_port "$p"; done; }

# nk_json_str <text> — text as a JSON string literal, quotes included.
nk_json_str() {
  local v=${1//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//$'\n'/\\n}
  v=${v//$'\t'/\\t}
  v=${v//$'\r'/}
  printf '"%s"' "$v"
}

# nk_port_state <port> — "free" | "<name> (pid N)"
nk_port_state() {
  local pids; pids=$(nk_port_pids "$1")
  if [ -z "$pids" ]; then printf 'free'; return; fi
  set -- $pids
  printf '%s (pid %s)' "$(nk_pid_name "$1")" "$1"
}

# nk_port_conflicts <stack> — print "<other-stack>:<port>" for every other stack
# that declares one of this stack's ports. grafana and glx both bind 3000, which
# is what turned into 30 rounds of lsof -i :3000 in the shell history.
nk_port_conflicts() {
  local me=$1 mine=$NK_PORTS other p q
  for other in $(nk_stacks); do
    [ "$other" = "$me" ] && continue
    (
      nk_load "$other" >/dev/null 2>&1 || exit 0
      for p in $mine; do
        for q in $NK_PORTS; do
          [ "$p" = "$q" ] && { printf '%s:%s\n' "$other" "$p"; exit 0; }
        done
      done
    )
  done
}

# --------------------------------------------------------- port discovery ----

# nk_tree_pids <pid> — the pid and every descendant, one per line.
nk_tree_pids() {
  local c
  printf '%s\n' "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do nk_tree_pids "$c"; done
}

# nk_detected <stack> — "port pid name" for every TCP listener owned by a
# process running inside the stack's tmux panes. This is what the stack is
# actually using, as opposed to what NK_PORTS says it should.
nk_detected() {
  nk_running "$1" || return 0
  command -v lsof >/dev/null || return 0
  local sess pids csv p
  sess=$(nk_session "$1")
  pids=$(for p in $(tmux list-panes -t "=$sess" -F '#{pane_pid}' 2>/dev/null); do
           nk_tree_pids "$p"; done | sort -un)
  [ -n "$pids" ] || return 0
  csv=$(printf '%s\n' $pids | paste -sd, -)
  lsof -nP -iTCP -sTCP:LISTEN -a -p "$csv" -Fpcn 2>/dev/null | awk '
    /^p/ { pid = substr($0, 2) }
    /^c/ { name = substr($0, 2) }
    /^n/ { n = substr($0, 2); sub(/.*:/, "", n)
           if (n ~ /^[0-9]+$/ && !(n in seen)) { seen[n] = 1; print n, pid, name } }' |
    sort -n
}

# ------------------------------------------------------------------- tmux ----

nk_running()      { tmux has-session -t "=$(nk_session "$1")" 2>/dev/null; }

# nk_pane_id <stack> <label> — the tmux pane id for a pane label. The label is
# kept in the @nk_label pane option: the pane *title* is also set, for people
# looking at tmux, but any program that emits a title escape (yarn, htop, a
# PS1 with \e]0;) overwrites the title, and then a title lookup finds nothing.
# Older tmux without pane options falls back to the title.
nk_pane_id() {
  local sess; sess=$(nk_session "$1")
  # $'\t': tmux prints a format string's backslashes literally, so the
  # separator has to be a real tab.
  tmux list-panes -t "=$sess" -F $'#{@nk_label}\t#{pane_title}\t#{pane_id}' 2>/dev/null |
    awk -F '\t' -v l="$2" '$1 == l { print $3; exit } $1 == "" && $2 == l { print $3; exit }'
}

# nk_pane_label <pane-id> — the label a pane was started with.
nk_pane_label() {
  local v; v=$(tmux display -p -t "$1" '#{@nk_label}' 2>/dev/null)
  [ -n "$v" ] && printf '%s' "$v" || tmux display -p -t "$1" '#{pane_title}'
}
nk_require_tmux() { command -v tmux >/dev/null || die "ต้องติดตั้ง tmux ก่อน: sudo apt install tmux"; }

# nk_sudo_shim <stack> — a directory to put first on a pane's PATH so every
# `sudo` in that pane (including ones inside a Makefile, which runs under sh and
# so cannot see a shell function) becomes `sudo -A` and takes the password from
# SUDO_ASKPASS. Prompt-scraping would be a guess; this is what sudo provides.
nk_sudo_shim() {
  local name=$1 dir="$NK_CACHE/shim/$name" pw
  pw=$(nk_secret_file "$name")
  mkdir -p "$dir"
  # The files end up read-only, so an earlier run's copies have to go before
  # they can be written again — a redirect onto a 0500 file fails, even for
  # its owner.
  rm -f "$dir/askpass" "$dir/sudo"
  printf '#!/bin/sh\ncat %s\n' "$(printf %q "$pw")" > "$dir/askpass"
  printf '#!/bin/sh\nexec %s -A "$@"\n' "$(command -v sudo || echo /usr/bin/sudo)" > "$dir/sudo"
  chmod 700 "$dir"; chmod 500 "$dir/askpass" "$dir/sudo"
  printf '%s' "$dir"
}

# nk_exit_file <stack> <label> — where a pane's wrapper leaves the exit code of
# its command. `nk up` clears these; while a pane's file exists its command has
# finished, and the shell in the pane is only there to keep the output readable.
nk_exit_file() { printf '%s/logs/%s--%s.exit' "$NK_CACHE" "$1" "$2"; }

# nk_pane_cmd <command> <label> — wrap a pane command with cd, optional env
# file, and a shell that stays alive after the process exits so errors stay
# readable. The exit code is recorded (see nk_exit_file) so the console can
# show a crashed pane as crashed rather than "running".
nk_pane_cmd() {
  local cmd=$1 label=${2:-app} pre= shim
  if nk_has_secret "$NK_NAME"; then
    shim=$(nk_sudo_shim "$NK_NAME")
    pre="export PATH=$(printf %q "$shim"):\$PATH SUDO_ASKPASS=$(printf %q "$shim/askpass"); "
  fi
  [ -n "$NK_ENV_FILE" ] && [ -f "$NK_DIR/$NK_ENV_FILE" ] &&
    pre="${pre}set -a; . ./$NK_ENV_FILE; set +a; "
  printf 'cd %q && %s%s; __rc=$?; printf %%s "$__rc" > %q; printf "\n[%s จบการทำงาน — exit %%s] กด enter เพื่อปิด pane\n" "$__rc"; read -r; exec bash' \
    "$NK_DIR" "$pre" "$cmd" "$(nk_exit_file "$NK_NAME" "$label")" "$NK_NAME"
}

# nk_hue <stack> — a stable 0..11 colour index for a stack name. The console
# uses the same hash, so a stack is the same colour in tmux and on the page.
nk_hue() {
  local s=$1 i h=0
  for ((i = 0; i < ${#s}; i++)); do h=$(( (h * 31 + $(printf '%d' "'${s:i:1}")) % 1000003 )); done
  printf '%s' $((h % 12))
}
# The 12 hues as tmux 256-colour indexes, in the same order as the page's palette.
NK_TMUX_HUES=(167 173 179 107 71 37 44 68 62 134 170 168)
