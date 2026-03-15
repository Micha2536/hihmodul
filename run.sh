#!/usr/bin/env sh
set -eu

IMAGE_NAME="${IMAGE_NAME:-vhih-hue-modul:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-vhih-hue-modul}"

MQTT_CONTAINER_NAME="${MQTT_CONTAINER_NAME:-vhih-mqtt-broker}"
MQTT_IMAGE="${MQTT_IMAGE:-eclipse-mosquitto:2}"
MQTT_PORT="${MQTT_PORT:-1883}"
MQTT_WS_PORT="${MQTT_WS_PORT:-9001}"

if [ "${NO_CACHE:-0}" = "1" ]; then
  docker build --no-cache -t "$IMAGE_NAME" .
else
  docker build -t "$IMAGE_NAME" .
fi

mkdir -p data
[ -f data/NodeFile.js ] || printf "[]\n" > data/NodeFile.js
[ -f data/NodeIdFile.js ] || printf "[]\n" > data/NodeIdFile.js
[ -f data/ServiceFile.js ] || printf "[]\n" > data/ServiceFile.js

# --- Mosquitto dirs + config ---
mkdir -p docker/mosquitto/data docker/mosquitto/log
if [ ! -f docker/mosquitto/mosquitto.conf ]; then
  cat > docker/mosquitto/mosquitto.conf <<EOF
listener ${MQTT_PORT}
allow_anonymous true

# optional websockets:
listener ${MQTT_WS_PORT}
protocol websockets
EOF
fi

# --- Restart Mosquitto ---
docker rm -f "$MQTT_CONTAINER_NAME" 2>/dev/null || true
docker run -d \
  --name "$MQTT_CONTAINER_NAME" \
  --restart unless-stopped \
  --network host \
  -v "$PWD/docker/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$PWD/docker/mosquitto/data:/mosquitto/data:rw" \
  -v "$PWD/docker/mosquitto/log:/mosquitto/log:rw" \
  "$MQTT_IMAGE"

# --- Restart App ---
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network host \
  -e DATA_DIR=/app/data \
  -e DEBUG_HOMEEAPI="${DEBUG_HOMEEAPI:-1}" \
  -v "$PWD/data:/app/data" \
  "$IMAGE_NAME"

echo ""
echo "[run.sh] Started:"
echo "  - MQTT broker: $MQTT_CONTAINER_NAME (host network, port ${MQTT_PORT})"
echo "  - App:         $CONTAINER_NAME"
echo ""
echo "[run.sh] Logs (app):"
docker logs -f "$CONTAINER_NAME"
