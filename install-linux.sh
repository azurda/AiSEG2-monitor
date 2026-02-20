#!/usr/bin/env bash
# install-linux.sh — Install AiSEG2 Dashboard as a systemd service
# Tested on: Arch Linux, Ubuntu 22.04+, Debian 12+
# Requires: systemd, Node.js 18+

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
SERVICE_NAME="aiseg2-dashboard"
PORT="${PORT:-3000}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
NODE_BIN="$(command -v node 2>/dev/null || echo '/usr/bin/node')"

# ── Checks ────────────────────────────────────────────────────────────────────
if [[ ! -x "$NODE_BIN" ]]; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first." >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[0])')"
if (( NODE_VERSION < 18 )); then
  echo "ERROR: Node.js 18+ required (found $NODE_VERSION)." >&2
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/server.js" ]]; then
  echo "ERROR: Run this script from the aiseg2 project directory." >&2
  exit 1
fi

# ── Install dependencies if needed ────────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  echo "→ Installing npm dependencies..."
  (cd "$INSTALL_DIR" && npm install --omit=dev)
fi

# ── Decide: system service (root) or user service (non-root) ─────────────────
if [[ $EUID -eq 0 ]]; then
  # ── System-wide service ───────────────────────────────────────────────────
  SERVICE_DIR="/etc/systemd/system"
  UNIT_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"

  echo "→ Creating system service at $UNIT_FILE ..."
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=AiSEG2 Energy Dashboard
Documentation=file://${INSTALL_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PORT=${PORT}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable  "${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"

  echo ""
  echo "✓ System service installed and started."
  echo "  Status:  systemctl status ${SERVICE_NAME}"
  echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
  echo "  Stop:    systemctl stop ${SERVICE_NAME}"
  echo "  Disable: systemctl disable ${SERVICE_NAME}"

else
  # ── User-level service (no sudo required) ─────────────────────────────────
  USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$USER_SYSTEMD_DIR"
  UNIT_FILE="${USER_SYSTEMD_DIR}/${SERVICE_NAME}.service"

  echo "→ Creating user service at $UNIT_FILE ..."
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=AiSEG2 Energy Dashboard
Documentation=file://${INSTALL_DIR}/README.md
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PORT=${PORT}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable  "${SERVICE_NAME}.service"
  systemctl --user restart "${SERVICE_NAME}.service"

  # Enable lingering so the service starts at boot without a login session
  loginctl enable-linger "$(whoami)" 2>/dev/null || \
    echo "  Note: Run 'sudo loginctl enable-linger $(whoami)' to start at boot without login."

  echo ""
  echo "✓ User service installed and started."
  echo "  Status:  systemctl --user status ${SERVICE_NAME}"
  echo "  Logs:    journalctl --user -u ${SERVICE_NAME} -f"
  echo "  Stop:    systemctl --user stop ${SERVICE_NAME}"
  echo "  Disable: systemctl --user disable ${SERVICE_NAME}"
fi

# ── Network info ──────────────────────────────────────────────────────────────
echo ""
echo "  Dashboard URL(s):"
ip -4 addr show 2>/dev/null | awk '/inet / && !/127\./ {
  sub("/.*","", $2); printf "    http://%s:'${PORT}'\n", $2
}' || hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | while read -r ip; do
  echo "    http://$ip:${PORT}"
done
echo ""
