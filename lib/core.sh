# shellcheck shell=bash
# core.sh — shared helpers for nk. Sourced by bin/nk, never run directly.

NK_ROOT="${NK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NK_HOME="${NK_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/nk}"
NK_PROJECT_DIRNAME="${NK_PROJECT_DIRNAME:-.nk}"
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
# Stacks are plain shell files found in three places, project first so a repo
# can override a shared definition:
#
#   1. <project>/.nk/*.sh   — committed with the repo, no absolute paths needed
#   2. ~/.config/nk/stacks  — personal, machine-specific
#   3. <devkit>/stacks      — shared defaults shipped with this checkout

# nk_project_root [dir] — nearest ancestor holding .nk/, else the git root,
# else the starting directory.
nk_project_root() {
  local d="${1:-$PWD}"
  d=$(cd "$d" 2>/dev/null && pwd) || { printf '%s' "${1:-$PWD}"; return; }
  local start=$d
  while [ "$d" != / ]; do
    [ -d "$d/$NK_PROJECT_DIRNAME" ] && { printf '%s' "$d"; return; }
    d=$(dirname "$d")
  done
  d=$start
  while [ "$d" != / ]; do
    [ -e "$d/.git" ] && { printf '%s' "$d"; return; }
    d=$(dirname "$d")
  done
  printf '%s' "$start"
}

# Registered projects: one root per line. Their .nk/ directories are searched
# from anywhere, so the console shows every project's stacks no matter where
# it was started. `nk init` and the console's "ย้ายไป project" register a root.
NK_PROJECTS_FILE="$NK_HOME/projects"

nk_projects() { [ -f "$NK_PROJECTS_FILE" ] && awk 'NF && !seen[$0]++' "$NK_PROJECTS_FILE"; return 0; }

nk_project_add() {
  local d; d=$(cd "$1" 2>/dev/null && pwd) || return 1
  mkdir -p "$NK_HOME"
  nk_projects | awk -v d="$d" '$0 == d { f = 1 } END { exit !f }' && return 0
  printf '%s\n' "$d" >> "$NK_PROJECTS_FILE"
}

nk_project_rm() {
  [ -f "$NK_PROJECTS_FILE" ] || return 0
  local d; d=$(cd "$1" 2>/dev/null && pwd) || d=$1
  awk -v d="$d" '$0 != d' "$NK_PROJECTS_FILE" > "$NK_PROJECTS_FILE.tmp" &&
    mv "$NK_PROJECTS_FILE.tmp" "$NK_PROJECTS_FILE"
}

# nk_search_dirs — stack directories in priority order: the project we are in,
# every registered project, the user's own, then the shared defaults.
nk_search_dirs() {
  local proj d; proj=$(nk_project_root)
  {
    [ -d "$proj/$NK_PROJECT_DIRNAME" ] && printf '%s\n' "$proj/$NK_PROJECT_DIRNAME"
    while read -r d; do
      [ -n "$d" ] && [ -d "$d/$NK_PROJECT_DIRNAME" ] && printf '%s\n' "$d/$NK_PROJECT_DIRNAME"
    done < <(nk_projects)
    [ -d "$NK_HOME/stacks" ] && printf '%s\n' "$NK_HOME/stacks"
    [ -d "$NK_ROOT/stacks" ] && printf '%s\n' "$NK_ROOT/stacks"
  } | awk '!seen[$0]++'
  return 0
}

# nk_stack_file <name> — path to the winning definition, empty if none.
nk_stack_file() {
  local name=$1 d
  while read -r d; do
    [ -n "$d" ] || continue
    [ -f "$d/$name.sh" ] && { printf '%s' "$d/$name.sh"; return 0; }
  done < <(nk_search_dirs)
  return 1
}

# nk_stacks — every stack name reachable from here, each listed once.
nk_stacks() {
  local d f n
  while read -r d; do
    [ -n "$d" ] || continue
    for f in "$d"/*.sh; do
      [ -e "$f" ] || continue
      n=$(basename "$f" .sh)
      case "$n" in _*) continue ;; esac
      printf '%s\n' "$n"
    done
  done < <(nk_search_dirs) | awk '!seen[$0]++'
}

# nk_load <stack> — source a stack definition into the current shell. Clears
# the NK_* contract first so one load cannot leak into the next.
nk_load() {
  local name=$1 file dir
  file=$(nk_stack_file "$name") ||
    die "ไม่รู้จัก stack '$name' (ดูรายการด้วย: nk list)"

  NK_NAME=$name NK_DIR= NK_PORTS= NK_URL= NK_ENV_FILE= NK_NOTE=
  NK_API_BASE= NK_TOKEN_CMD= NK_FILE=$file
  NK_PANES=()

  # A stack living in <project>/.nk defaults to that project root, so repo
  # definitions stay free of absolute paths and work on any machine.
  dir=$(dirname "$file")
  [ "$(basename "$dir")" = "$NK_PROJECT_DIRNAME" ] && NK_DIR=$(dirname "$dir")

  # shellcheck disable=SC1090
  . "$file"

  NK_DIR="${NK_DIR/#\~/$HOME}"
  [ -n "$NK_DIR" ]          || die "$name: ไม่ได้ตั้ง NK_DIR ($file)"
  [ -d "$NK_DIR" ]          || die "$name: ไม่มีไดเรกทอรี $NK_DIR ($file)"
  [ ${#NK_PANES[@]} -gt 0 ] || die "$name: ไม่ได้ตั้ง NK_PANES ($file)"
}

# nk_resolve_stack — the stack that token/curl/mk should act on:
# an explicit argument, else $NK_STACK, else the only project-local stack.
nk_resolve_stack() {
  [ -n "${1:-}" ] && { printf '%s' "$1"; return 0; }
  [ -n "${NK_STACK:-}" ] && { printf '%s' "$NK_STACK"; return 0; }

  local proj found n
  proj=$(nk_project_root)
  if [ -d "$proj/$NK_PROJECT_DIRNAME" ]; then
    found=$(cd "$proj/$NK_PROJECT_DIRNAME" && ls ./*.sh 2>/dev/null |
      sed 's@^\./@@;s@\.sh$@@')
    n=$(printf '%s\n' "$found" | grep -c .) || true
    [ "$n" = 1 ] && { printf '%s' "$found"; return 0; }
  fi
  return 1
}

nk_session() { printf '%s%s' "$NK_PREFIX" "$1"; }

# ------------------------------------------------------------------ ports ----

# nk_port_pids <port> — pids listening on the port, ours first then root-owned.
nk_port_pids() {
  local port=$1 pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ] && command -v sudo >/dev/null; then
    pids=$(sudo -n lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  fi
  printf '%s' "$pids"
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
nk_require_tmux() { command -v tmux >/dev/null || die "ต้องติดตั้ง tmux ก่อน: sudo apt install tmux"; }

# nk_pane_cmd <command> — wrap a pane command with cd, optional env file, and a
# shell that stays alive after the process exits so errors stay readable.
nk_pane_cmd() {
  local cmd=$1 pre=
  [ -n "$NK_ENV_FILE" ] && [ -f "$NK_DIR/$NK_ENV_FILE" ] &&
    pre="set -a; . ./$NK_ENV_FILE; set +a; "
  printf 'cd %q && %s%s; printf "\n[%s จบการทำงาน — exit %%s] กด enter เพื่อปิด pane\n" "$?"; read -r; exec bash' \
    "$NK_DIR" "$pre" "$cmd" "$NK_NAME"
}
