#!/usr/bin/env bash
# Pull-based deploy for dispatcher-api. Mirrors ozserver-deploy: redeploy only when
# origin/main has moved, health-gate the result, roll back on failure. flock prevents
# overlapping runs.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/aed-dispatcher}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/health}"
LOCK="/tmp/aed-dispatcher-deploy.lock"

exec 9>"$LOCK"
flock -n 9 || { echo "another deploy is running"; exit 0; }

cd "$APP_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "deploying $LOCAL -> $REMOTE"
PREV="$LOCAL"
git reset --hard "$REMOTE"   # .env is gitignored and untouched

deploy() {
  docker compose --project-directory "$APP_DIR" up -d --build
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$HEALTH_URL" | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

deploy
if healthy; then
  echo "deploy ok: $(git rev-parse --short HEAD)"
else
  echo "health check failed — rolling back to $PREV"
  git reset --hard "$PREV"
  deploy
  healthy && echo "rolled back and healthy" || echo "ROLLBACK ALSO UNHEALTHY — needs attention"
  exit 1
fi
