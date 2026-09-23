#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="pedivoy.service"
PROJECT_DIR="/home/lemac/.openclaw/workspace-pedivoy/PediVoy"
SERVICE_SRC="$PROJECT_DIR/scripts/$SERVICE_NAME"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"

if [[ $EUID -ne 0 ]]; then
  echo "Este script necesita sudo/root."
  exit 1
fi

install -d -m 755 "$PROJECT_DIR/logs"
install -m 644 "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Limpia el @reboot anterior si existe, para no duplicar arranques
su - lemac -c "crontab -l 2>/dev/null | grep -v '@reboot /bin/bash -lc '\''cd /home/lemac/.openclaw/workspace-pedivoy/PediVoy && /usr/bin/npm start >> /home/lemac/.openclaw/workspace-pedivoy/PediVoy/logs/autostart.log 2>&1'\''' | crontab - || true"

systemctl status "$SERVICE_NAME" --no-pager -l

echo
echo "Instalación completa."
echo "Logs: journalctl -u $SERVICE_NAME -f"
