#!/usr/bin/env bash
# install-macos.sh — Install AiSEG2 Dashboard as a launchd service on macOS
# Tested on: macOS 13 Ventura, 14 Sonoma (Apple Silicon & Intel)
# Requires: Node.js 18+ (install via https://nodejs.org or `brew install node`)

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
LABEL="com.aiseg2.dashboard"
PORT="${PORT:-3000}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node 2>/dev/null || echo '')"
LOG_DIR="${HOME}/Library/Logs/aiseg2"

# ── Checks ────────────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script is for macOS only. Use install-linux.sh on Linux." >&2
  exit 1
fi

# Try common Node.js locations if not in PATH
for candidate in \
    "$NODE_BIN" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /opt/local/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ ! -x "${NODE_BIN:-}" ]]; then
  echo "ERROR: Node.js not found."
  echo "  Install from https://nodejs.org  or  brew install node" >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -e 'console.log(process.versions.node.split(".")[0])')"
if (( NODE_VERSION < 18 )); then
  echo "ERROR: Node.js 18+ required (found v${NODE_VERSION})." >&2
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/server.js" ]]; then
  echo "ERROR: Run this script from the aiseg2 project directory." >&2
  exit 1
fi

# ── Install npm dependencies if needed ───────────────────────────────────────
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  echo "→ Installing npm dependencies..."
  (cd "$INSTALL_DIR" && npm install --omit=dev)
fi

# ── Prepare log directory ─────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── Determine service location ────────────────────────────────────────────────
# LaunchAgents run as the current user (recommended for personal Mac Mini).
# LaunchDaemons run as root at boot (requires sudo, survives logout).
#
# Use LaunchAgents unless sudo was used to run this script.

if [[ $EUID -eq 0 ]]; then
  PLIST_DIR="/Library/LaunchDaemons"
  PLIST_FILE="${PLIST_DIR}/${LABEL}.plist"
  RUN_AS_ROOT="true"
else
  PLIST_DIR="${HOME}/Library/LaunchAgents"
  PLIST_FILE="${PLIST_DIR}/${LABEL}.plist"
  RUN_AS_ROOT="false"
  mkdir -p "$PLIST_DIR"
fi

# ── Unload previous version if exists ────────────────────────────────────────
if [[ -f "$PLIST_FILE" ]]; then
  echo "→ Unloading existing service..."
  if [[ "$RUN_AS_ROOT" == "true" ]]; then
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
  else
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
  fi
fi

# ── Write plist ───────────────────────────────────────────────────────────────
echo "→ Writing plist to $PLIST_FILE ..."

if [[ "$RUN_AS_ROOT" == "true" ]]; then
  # LaunchDaemon — runs as a specific user at system boot
  CURRENT_USER="${SUDO_USER:-$(logname 2>/dev/null || whoami)}"
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOME</key>
    <string>/Users/${CURRENT_USER}</string>
  </dict>

  <key>UserName</key>
  <string>${CURRENT_USER}</string>

  <key>StandardOutPath</key>
  <string>/Users/${CURRENT_USER}/Library/Logs/aiseg2/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/${CURRENT_USER}/Library/Logs/aiseg2/stderr.log</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
EOF

  # Fix ownership (plist must be owned by root for LaunchDaemons)
  chown root:wheel "$PLIST_FILE"
  chmod 644 "$PLIST_FILE"

  launchctl load -w "$PLIST_FILE"

else
  # LaunchAgent — runs as current user, starts on login
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
EOF

  launchctl load -w "$PLIST_FILE"
fi

# ── Wait and check ────────────────────────────────────────────────────────────
sleep 2
if launchctl list | grep -q "${LABEL}"; then
  PID=$(launchctl list | awk -v label="${LABEL}" '$3==label{print $1}')
  echo ""
  echo "✓ Service installed and running (PID: ${PID:-unknown})."
else
  echo ""
  echo "⚠  Service installed but may not have started yet."
  echo "   Check: ${LOG_DIR}/stderr.log"
fi

# ── Print management commands ─────────────────────────────────────────────────
echo ""
if [[ "$RUN_AS_ROOT" == "true" ]]; then
  echo "  Logs:    tail -f /Users/${CURRENT_USER}/Library/Logs/aiseg2/stdout.log"
  echo "  Stop:    sudo launchctl unload ${PLIST_FILE}"
  echo "  Start:   sudo launchctl load -w ${PLIST_FILE}"
  echo "  Remove:  sudo launchctl unload ${PLIST_FILE} && sudo rm ${PLIST_FILE}"
else
  echo "  Logs:    tail -f ${LOG_DIR}/stdout.log"
  echo "  Stop:    launchctl unload ${PLIST_FILE}"
  echo "  Start:   launchctl load -w ${PLIST_FILE}"
  echo "  Remove:  launchctl unload ${PLIST_FILE} && rm ${PLIST_FILE}"
fi

echo ""
echo "  Dashboard URL(s):"
ifconfig 2>/dev/null | awk '/inet / && !/127\./ {
  print "    http://" $2 ":'${PORT}'"
}'
echo ""

# ── macOS firewall note ───────────────────────────────────────────────────────
echo "  Note: If the dashboard is not reachable from other devices, allow"
echo "  incoming connections in System Settings → Network → Firewall."
echo ""
