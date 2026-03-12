#!/usr/bin/env sh
set -eu

IMAGE_NAME="${IMAGE_NAME:-vhih-hue-modul:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-vhih-hue-modul}"

docker build -t "$IMAGE_NAME" .

mkdir -p data
[ -f data/NodeFile.js ] || printf "[]\n" > data/NodeFile.js
[ -f data/NodeIdFile.js ] || printf "[]\n" > data/NodeIdFile.js
[ -f data/ServiceFile.js ] || printf "[]\n" > data/ServiceFile.js

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network host \
  -e DATA_DIR=/app/data \
  -e DEBUG_HOMEEAPI="${DEBUG_HOMEEAPI:-1}" \
  -v "$PWD/data:/app/data" \
  "$IMAGE_NAME"

docker logs -f "$CONTAINER_NAME"
