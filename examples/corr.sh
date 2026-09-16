# corr — NLG correlation engine (alarm correlation / kafka consumer).
NK_DIR="$HOME/nlg-correlation"
NK_PORTS="3080"
NK_URL="http://localhost:3080"
NK_API_BASE="http://localhost:3080"
NK_PANES=(
  "server|make build-local && ./bin/nlg-correlation server"
)
NK_NOTE="ยิง traffic ทดสอบ: go build -o bin/logfeed ./tools/logfeed && ./bin/logfeed -rate 40 -duration 2m -incident-rate 0.20 -seed 42"
