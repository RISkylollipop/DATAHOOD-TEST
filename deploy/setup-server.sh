#!/usr/bin/env bash
# ============================================================
#  One-time VPS provisioning for DATAHOOD / KwaraPolyData.
#  Target: fresh Ubuntu 24.04 LTS, run as root.
#
#  Run ONCE per server. It is idempotent — re-running is safe and
#  is the intended way to repair a half-finished setup.
#
#      bash setup-server.sh datahood kwarapolydata.com.ng
#
#  What it does NOT do: install MySQL (see the note at the end),
#  write any secret, or obtain the TLS certificate. Those are
#  deliberate — secrets are typed by you, once, into a root-only
#  file, and never live in a script that could be committed.
# ============================================================
set -euo pipefail

APP_USER="${1:-datahood}"
DOMAIN="${2:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash setup-server.sh <app-user> <domain>" >&2
  exit 1
fi
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash setup-server.sh <app-user> <domain>" >&2
  exit 1
fi

echo "==> Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx ufw fail2ban unattended-upgrades

echo "==> Node.js 22 LTS"
# The frontend requires Node >= 20.19 (frontend/package.json engines) and the
# backend is ESM with a native bcrypt build. 22 LTS satisfies both.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "==> Swap (build headroom)"
# `vite build` peaks well above 1GB. On a 4GB box it fits, but the OOM killer
# taking out MySQL mid-deploy is a bad way to find the edge, and swap is free.
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Application user (no login shell, no password)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "/home/$APP_USER/app"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "/home/$APP_USER/app/backend/logs"

echo "==> Secrets directory (root-only)"
# 0700/0600. The systemd unit reads this as root before dropping to $APP_USER,
# so the app never needs permission to read its own secrets file.
install -d -o root -g root -m 700 /etc/datahood
if [[ ! -f /etc/datahood/api.env ]]; then
  touch /etc/datahood/api.env
  chmod 600 /etc/datahood/api.env
  echo "    created empty /etc/datahood/api.env — fill it in before starting"
fi

echo "==> Firewall"
# Default-deny inbound. The API listens on 127.0.0.1 only (see the systemd
# unit), so port 5000 is never opened — nginx is the sole way in.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status verbose

echo "==> Automatic security updates"
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "==> Log rotation"
# backend/utils/logger.js appends one file per level per DAY and never prunes.
# Without this the disk fills quietly and the first symptom is a dead server.
cat > /etc/logrotate.d/datahood <<EOF
/home/$APP_USER/app/backend/logs/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su $APP_USER $APP_USER
}
EOF

echo "==> nginx security headers"
# Must be installed BEFORE the site config, because nginx.conf includes it
# and `nginx -t` below fails outright on a missing include. The snippets/
# directory ships with the Debian/Ubuntu nginx package, but mkdir -p costs
# nothing and covers a source build.
#
# __DOMAIN__ is substituted here too — the snippet's header carries the
# curl commands for verifying the headers actually arrive, and a verify
# step you have to hand-edit before running is a verify step nobody runs.
mkdir -p /etc/nginx/snippets
sed -e "s/__DOMAIN__/$DOMAIN/g" \
  "$(dirname "$0")/nginx-security-headers.conf" > /etc/nginx/snippets/datahood-security-headers.conf

echo "==> nginx site"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_USER__/$APP_USER/g" \
  "$(dirname "$0")/nginx.conf" > "/etc/nginx/sites-available/$DOMAIN"
ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "==> systemd unit"
sed -e "s/__APP_USER__/$APP_USER/g" \
  "$(dirname "$0")/datahood-api.service" > /etc/systemd/system/datahood-api.service
systemctl daemon-reload
systemctl enable datahood-api >/dev/null

cat <<EOF

============================================================
Base server is ready. Remaining steps, in order:

 1. Point DNS: an A record for $DOMAIN -> this server's IPv4.
    Wait for it to resolve before step 2 or certbot will fail.

 2. TLS (free, auto-renewing):
      apt-get install -y certbot python3-certbot-nginx
      certbot --nginx -d $DOMAIN -d www.$DOMAIN

 3. Fill in /etc/datahood/api.env  (chmod 600, root only).
    Use backend/.env.example for the full key list. Generate the
    two secrets ON THE SERVER, never reuse the development ones:
      node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # JWT_SECRET
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # APP_ENCRYPTION_KEY
    These MUST match the live domain or you get subtle breakage:
      NODE_ENV=production
      PORT=5000
      CLIENT_ORIGINS=https://$DOMAIN
      WEBAUTHN_RP_ID=$DOMAIN
      WEBAUTHN_ORIGIN=https://$DOMAIN

 4. Deploy the code:  bash deploy.sh $APP_USER

 5. Tell your fulfilment providers (Premiumsub et al.) to whitelist
    this server's IPv4. It is static and it is the only address
    your outbound provider calls will ever come from.

 6. Point the Monnify/Paystack webhook at:
      https://$DOMAIN/api/payment/webhook

DATABASE: this script does not install MySQL, because you already
have one at an external host. If you move it onto this box:
      apt-get install -y mysql-server && mysql_secure_installation
      CREATE DATABASE kwarapo1_datahood
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
Keep DB_HOST=127.0.0.1 and do NOT open 3306 in the firewall.
Then set up backups — see backup-db.sh in this folder.
============================================================
EOF
