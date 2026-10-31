#!/usr/bin/env bash
# ============================================================
#  Deploy / update. Run as root on the server, after setup-server.sh.
#
#      bash deploy.sh datahood
#
#  Safe to re-run. The order below is not arbitrary:
#  build BEFORE stopping the API, so a failed build costs zero
#  downtime instead of leaving the site down while you debug it.
# ============================================================
set -euo pipefail

APP_USER="${1:-datahood}"
APP_DIR="/home/$APP_USER/app"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy.sh <app-user>" >&2
  exit 1
fi
[[ -d "$APP_DIR/backend" ]] || { echo "No code at $APP_DIR — clone or rsync it there first." >&2; exit 1; }

run_as() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $1"; }

echo "==> Backend dependencies (production only)"
run_as "cd backend && npm ci --omit=dev"

echo "==> Frontend dependencies + build"
# Dev deps ARE needed here: vite is one of them. The build output is
# static, so nothing from node_modules is served.
#
# No VITE_API_URL on purpose — nginx serves the API under the same
# origin at /api, and config.jsx falls through to that by default.
run_as "cd frontend && npm ci && npm run build"

# Fail loudly rather than serving an empty directory: nginx would
# answer 404 for index.html and the site would look "up but blank".
# build/, not dist/ — vite.config.js overrides outDir to the CRA path.
[[ -s "$APP_DIR/frontend/build/index.html" ]] || { echo "Build produced no frontend/build/index.html — refusing to continue." >&2; exit 1; }

# The API URL must never be baked in as localhost. This exact failure
# shipped once and broke every login on a phone, silently, while the
# build machine looked fine. One grep is cheaper than that outage.
if grep -rq "localhost:5000" "$APP_DIR/frontend/build/assets/" 2>/dev/null; then
  echo "Build contains localhost:5000 — a stale VITE_API_URL is set. Refusing to deploy." >&2
  exit 1
fi

echo "==> Database migrations"
# migrate.js has no ledger and re-runs every statement, so every
# migration in it must be idempotent (CREATE TABLE IF NOT EXISTS, etc).
# Run it BEFORE restarting: the new code may expect the new columns,
# and a model whose column is missing from the live DB reads to the
# user as "all my data is gone".
set -a; . /etc/datahood/api.env; set +a
run_as "cd backend && npm run db:migrate"

echo "==> Restart API"
systemctl restart datahood-api
sleep 3
systemctl is-active --quiet datahood-api || { journalctl -u datahood-api -n 40 --no-pager; exit 1; }

echo "==> Reload nginx"
nginx -t && systemctl reload nginx

echo "==> Health check"
# Ask the app, not systemd. A process can be running and still be
# unable to reach the database, which is the failure that matters.
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 http://127.0.0.1:5000/api/health >/dev/null; then
    echo "    healthy"
    exit 0
  fi
  sleep 2
done

echo "API did not answer /api/health after 5 tries." >&2
journalctl -u datahood-api -n 40 --no-pager
exit 1
