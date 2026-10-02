#!/usr/bin/env bash
# Deploys the current folder to the VPS: syncs code, rebuilds the image, restarts the container.
# Usage: ./deploy.sh            (uses the "connecto-vps" host from ~/.ssh/config)
set -euo pipefail
HOST="${DEPLOY_HOST:-connecto-vps}"
DIR=/docker/connecto

npm test
rsync -az --delete \
  --exclude node_modules --exclude data --exclude test --exclude .git --exclude .DS_Store --exclude .env \
  ./ "$HOST:$DIR/"
# First deploy only: create the server-side .env with a random TURN secret.
ssh "$HOST" "cd $DIR && [ -f .env ] || (umask 077; echo TURN_SECRET=\$(openssl rand -hex 32) > .env)"
ssh "$HOST" "cd $DIR && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null"
echo "Waiting for health check…"
for i in $(seq 1 30); do
  status=$(ssh "$HOST" "docker inspect --format '{{.State.Health.Status}}' connecto-connecto-1" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then echo "Deployed ✔"; exit 0; fi
  sleep 2
done
echo "Container did not become healthy; recent logs:"; ssh "$HOST" "docker logs --tail 50 connecto-connecto-1"; exit 1
