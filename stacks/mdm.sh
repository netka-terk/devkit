# mdm — nksmdm (Unified Endpoint Management). Binds 443 via cap_net_bind_service,
# so `make build-nksmdm` runs sudo setcap and may prompt for a password.
NK_DIR="$HOME/nkss"
NK_PORTS="443 8443"
NK_URL="https://mdm.local"
NK_API_BASE="https://mdm.local"
NK_TOKEN_CMD="make -s admin-token"
NK_ENV_FILE=".env"
NK_PANES=(
  "nksmdm|make run-nksmdm"
)
NK_NOTE="nk curl mdm /api/health | nk mk -s mdm remote-session HOST=1"
