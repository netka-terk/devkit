# glx — NLG Galaxy dashboard service, dev build (seeds an EE license so admin can
# reach ITIM/MDM/MDES pages without pasting one). Shares port 3000 with grafana.
NK_DIR="$HOME/nkss"
NK_PORTS="3000"
NK_URL="http://localhost:3000"
NK_ENV_FILE=".env"
NK_PANES=(
  "nksglx|make run-nksglx-dev"
)
NK_NOTE="ชน port 3000 กับ grafana — รันพร้อมกันไม่ได้"
