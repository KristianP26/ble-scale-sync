# ── Build stage: compile TypeScript ──────────────────────────────────
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:20-slim

# OCI labels
ARG VERSION=dev
ARG BUILD_DATE
ARG VCS_REF
LABEL org.opencontainers.image.title="BLE Scale Sync" \
      org.opencontainers.image.description="Universal BLE Smart Scale bridge — Garmin Connect, MQTT, InfluxDB, Webhook, Ntfy" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/KristianP26/ble-scale-sync" \
      org.opencontainers.image.licenses="GPL-3.0"

# System dependencies: BLE (BlueZ + D-Bus), Python (Garmin upload), tini (PID 1),
# build-essential (node-gyp needs gcc/g++/make for native BLE modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
      bluez \
      libbluetooth-dev \
      libusb-1.0-0-dev \
      libdbus-1-dev \
      build-essential \
      python3 \
      python3-pip \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies (Garmin upload)
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# Node.js dependencies (production only)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled application
COPY --from=build /app/dist/ ./dist/

# Supporting files
COPY garmin-scripts/ ./garmin-scripts/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Non-root user (UID 1000 from node:20-slim)
# chown /app so the node user can create .tmp files for atomic config writes
RUN chown node:node /app
USER node

# Heartbeat check: /tmp/.ble-scale-sync-heartbeat must be updated within 5 minutes
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD test -f /tmp/.ble-scale-sync-heartbeat && \
      [ "$(find /tmp/.ble-scale-sync-heartbeat -mmin -5 2>/dev/null)" ] || exit 1

ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
CMD ["start"]
