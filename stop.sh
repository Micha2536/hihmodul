#!/usr/bin/env sh
set -eu
CONTAINER_NAME="${CONTAINER_NAME:-vhih-hue-modul}"
docker stop "$CONTAINER_NAME" 2>/dev/null || true
