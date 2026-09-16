# grafana — NLG Grafana fork. Backend hot-reloads via bra, frontend via webpack.
NK_DIR="$HOME/grafana"
NK_PORTS="3000"
NK_URL="http://localhost:3000"
NK_API_BASE="http://localhost:3000"
NK_PANES=(
  "backend|make run"
  "frontend|yarn start"
)
NK_NOTE="frontend เป็น webpack watch (ไม่ได้ bind port) — เข้าเว็บที่ backend 3000"
