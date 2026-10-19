#!/usr/bin/env bash
# Builds the server image, ships it to the NAS, (re)starts the service and
# adds the /bluray/* route to Caddy. Run from the Mac: npm run server:deploy
# With --owner-code it deploys nothing: it mints one owner pairing code on the
# running server and prints it with its link and a terminal QR. Extra args go to
# the command: --owner-code --person <name> mints for that owner person.
set -euo pipefail

HOST="${BLURAY_NAS_HOST:-mediaserver}"

if [ "${1:-}" = "--owner-code" ]; then
  shift
  # Extra args (such as --person <name>) pass through, quoted for the remote shell.
  ARGS=""
  if [ $# -gt 0 ]; then ARGS="$(printf ' %q' "$@")"; fi
  exec ssh "$HOST" "docker exec bluray-server node server.mjs owner-code$ARGS"
fi

REMOTE_DIR='~/bluray-server'
cd "$(dirname "$0")/../.."

TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then TAG="$TAG-dirty"; fi

echo "==> Bundling the server"
npm run server:build

echo "==> Building bluray-server:$TAG for linux/amd64"
docker buildx build --platform linux/amd64 --load \
  -t "bluray-server:$TAG" -t bluray-server:latest \
  -f server/Dockerfile server

echo "==> Shipping the image to $HOST"
docker save "bluray-server:$TAG" bluray-server:latest | gzip | ssh "$HOST" 'gunzip | docker load'

echo "==> Writing $REMOTE_DIR/compose.yaml and starting the service"
ssh "$HOST" "mkdir -p $REMOTE_DIR && cat > $REMOTE_DIR/compose.yaml" < server/deploy/compose.yaml
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d"

echo "==> Routing /bluray/* in Caddy"
ssh "$HOST" 'bash -s' < server/deploy/caddy-route.sh

echo "==> Done: https://mediaserver.tailnet-8e55.ts.net/bluray/api/health"
