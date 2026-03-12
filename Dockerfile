# syntax=docker/dockerfile:1
#
# Raspberry Pi / Multi-arch friendly Node image.
# If you run on an older Pi OS (32-bit), use `node:18-bullseye-slim` instead.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Shelly discovery uses avahi-browse (mDNS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends avahi-utils \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy app sources
COPY . .

# Default ports used by this project:
# - 7681/tcp: Homee API server (homeeAPI.mjs)
# - 3333/tcp: Console SSE server (consolesse.mjs) (optional)
# - 15263/udp: Discovery server (discovery.js)
EXPOSE 8100 7681 3333 15263/udp

# Make sure runtime state files exist (can be overridden via volumes)
RUN test -f NodeFile.js || printf "[]\n" > NodeFile.js      && test -f NodeIdFile.js || printf "[]\n" > NodeIdFile.js      && test -f ServiceFile.js || printf "[]\n" > ServiceFile.js

CMD ["npm", "start"]
