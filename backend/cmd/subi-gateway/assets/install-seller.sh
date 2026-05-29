#!/usr/bin/env bash
set -euo pipefail

GATEWAY=""
SETUP_TOKEN=""
AGENT_PATH=""
INSTALL_DIR="${SUBI_SELLER_INSTALL_DIR:-$HOME/.subi/seller}"

usage() {
  cat >&2 <<'EOF'
Usage:
  install-seller.sh --gateway https://api.subi.example --setup-token subi_setup_xxx [--agent-path ./dist/seller-agent]

The setup token is exchanged once for this seller node's local config.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway)
      GATEWAY="${2:-}"
      shift 2
      ;;
    --setup-token)
      SETUP_TOKEN="${2:-}"
      shift 2
      ;;
    --agent-path)
      AGENT_PATH="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ -n "$GATEWAY" ]] || { echo "ERROR: --gateway is required" >&2; exit 2; }
[[ -n "$SETUP_TOKEN" ]] || { echo "ERROR: --setup-token is required" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 2; }

GATEWAY="${GATEWAY%/}"
mkdir -p "$INSTALL_DIR"

CONFIG_JSON="$(mktemp -t subi-seller-setup.XXXXXX.json)"
trap 'rm -f "$CONFIG_JSON"' EXIT

curl -fsSL "$GATEWAY/api/v1/subi/seller/setup?token=$SETUP_TOKEN" -o "$CONFIG_JSON"

python3 - "$CONFIG_JSON" "$INSTALL_DIR/config.env" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
config = payload.get("seller_config_env", "")
if not config:
    raise SystemExit("setup response did not include seller_config_env")
path = pathlib.Path(sys.argv[2])
path.write_text(config + "\n")
path.chmod(0o600)
print(payload.get("subi_node_id", "seller-node"))
PY

if CODEX_BIN="$(command -v codex 2>/dev/null)"; then
  python3 - "$INSTALL_DIR/config.env" "$CODEX_BIN" <<'PY'
import pathlib
import shlex
import sys

path = pathlib.Path(sys.argv[1])
codex_bin = sys.argv[2]
lines = path.read_text().splitlines()
out = []
seen_bin = False
seen_app_server_bin = False
for line in lines:
    if line.startswith("SELLER_CODEX_BIN="):
        out.append("SELLER_CODEX_BIN=" + shlex.quote(codex_bin))
        seen_bin = True
    elif line.startswith("SELLER_CODEX_APP_SERVER_BIN="):
        out.append("SELLER_CODEX_APP_SERVER_BIN=" + shlex.quote(codex_bin))
        seen_app_server_bin = True
    else:
        out.append(line)
if not seen_bin:
    out.append("SELLER_CODEX_BIN=" + shlex.quote(codex_bin))
if not seen_app_server_bin:
    out.append("SELLER_CODEX_APP_SERVER_BIN=" + shlex.quote(codex_bin))
path.write_text("\n".join(out) + "\n")
path.chmod(0o600)
PY
fi

if [[ -n "$AGENT_PATH" ]]; then
  [[ -x "$AGENT_PATH" ]] || chmod +x "$AGENT_PATH"
  cp "$AGENT_PATH" "$INSTALL_DIR/seller-agent"
elif command -v seller-agent >/dev/null 2>&1; then
  cp "$(command -v seller-agent)" "$INSTALL_DIR/seller-agent"
elif [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" && -x "./dist/seller-agent-darwin-arm64" ]]; then
  cp "./dist/seller-agent-darwin-arm64" "$INSTALL_DIR/seller-agent"
elif [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" && -x "./dist/seller-agent-linux-amd64" ]]; then
  cp "./dist/seller-agent-linux-amd64" "$INSTALL_DIR/seller-agent"
elif [[ -x "./dist/seller-agent" ]]; then
  cp "./dist/seller-agent" "$INSTALL_DIR/seller-agent"
else
  echo "ERROR: seller-agent binary was not found." >&2
  echo "Build it first, then rerun with --agent-path ./dist/seller-agent-<os>-<arch>." >&2
  exit 2
fi
chmod +x "$INSTALL_DIR/seller-agent"

mkdir -p "$INSTALL_DIR/work"

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/network.subi.seller-agent.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>network.subi.seller-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>set -a; source "$INSTALL_DIR/config.env"; set +a; exec "$INSTALL_DIR/seller-agent" >> "$INSTALL_DIR/seller-agent.log" 2>&amp;1</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  echo "Subi seller-agent installed and started with launchd."
elif command -v systemctl >/dev/null 2>&1; then
  USER_SYSTEMD="$HOME/.config/systemd/user"
  mkdir -p "$USER_SYSTEMD"
  cat >"$USER_SYSTEMD/subi-seller-agent.service" <<EOF
[Unit]
Description=Subi Seller Agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/sh -lc 'set -a; . "$INSTALL_DIR/config.env"; set +a; exec "$INSTALL_DIR/seller-agent"'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now subi-seller-agent
  echo "Subi seller-agent installed and started with systemd --user."
else
  nohup /bin/sh -lc "set -a; . '$INSTALL_DIR/config.env'; set +a; exec '$INSTALL_DIR/seller-agent'" >>"$INSTALL_DIR/seller-agent.log" 2>&1 &
  echo "Subi seller-agent started with nohup."
fi

echo "Config: $INSTALL_DIR/config.env"
echo "Logs:   $INSTALL_DIR/seller-agent.log"
