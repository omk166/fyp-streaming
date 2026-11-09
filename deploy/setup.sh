#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VM (Oracle Always Free, etc).
# Run from the project directory on the VM:  sudo bash deploy/setup.sh
# Gives you https://<ip-with-dashes>.sslip.io (free hostname, real Let's Encrypt cert).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org)}"
DOMAIN="${DOMAIN:-$(echo "$PUBLIC_IP" | tr . -).sslip.io}"
EMAIL="${EMAIL:-}"
echo "Public IP: $PUBLIC_IP  Domain: $DOMAIN  App: $APP_DIR"

apt-get update
apt-get install -y curl ca-certificates build-essential python3 python3-pip certbot iptables-persistent
# Node 22
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Open ports in the VM's own firewall (Oracle images block them by default)
for rule in "tcp --dport 80" "tcp --dport 443" "tcp --dport 40000" "udp --dport 40000"; do
  iptables -C INPUT -p $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p $rule -j ACCEPT
done
netfilter-persistent save

# Certificate (needs port 80 free and DNS for $DOMAIN, which sslip.io provides)
CERTBOT_ARGS=(certonly --standalone -d "$DOMAIN" --agree-tos --non-interactive)
if [ -n "$EMAIL" ]; then CERTBOT_ARGS+=(-m "$EMAIL"); else CERTBOT_ARGS+=(--register-unsafely-without-email); fi
certbot "${CERTBOT_ARGS[@]}"

# Restart app after cert renewal
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl restart fyp-streaming\n' > /etc/letsencrypt/renewal-hooks/deploy/fyp-streaming.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/fyp-streaming.sh

# Build app
cd "$APP_DIR"
npm ci
npm run build

# Service: runs on boot, restarts on crash, may bind 443 without root
cat > /etc/systemd/system/fyp-streaming.service <<EOF
[Unit]
Description=FYP Streaming Lab
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
Environment=HOST=0.0.0.0 PORT=443 MEDIA_IP=0.0.0.0 ANNOUNCED_ADDRESS=$PUBLIC_IP
Environment=TLS_CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem TLS_KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
# Root is needed to read the cert files; port 443 is then allowed implicitly.
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now fyp-streaming
sleep 2
systemctl --no-pager status fyp-streaming | head -8
echo
echo "Done. Open: https://$DOMAIN"
echo "Also open TCP 80/443 and TCP+UDP 40000 in the cloud provider's network rules (security list), not just on the VM."
