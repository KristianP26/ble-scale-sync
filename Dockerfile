# ── Build stage: compile TypeScript ──────────────────────────────────
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build

# ── Python stage: Python 3.12 for garminconnect 0.3.x ────────────────
# Debian bookworm (node:22's base) ships Python 3.11; garminconnect 0.3.x
# requires >=3.12. Switching the whole runtime base to node:22-trixie-slim
# fixed that but broke linux/arm/v7: Docker's node image has no published
# arm/v7 manifest for trixie tags (Raspberry Pi Zero 2W / other 32-bit ARM
# boards). python:3.12-slim-bookworm is a self-contained Python 3.12 built
# against bookworm's glibc *and* does publish arm/v7, so copy just the
# interpreter across instead of changing the base OS.
FROM python:3.12-slim-bookworm AS python

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# OCI labels
ARG VERSION=local
ARG BUILD_DATE
ARG VCS_REF
LABEL org.opencontainers.image.title="BLE Scale Sync" \
      org.opencontainers.image.description="Universal BLE Smart Scale bridge — Garmin Connect, MQTT, InfluxDB, Webhook, Ntfy" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/KristianP26/ble-scale-sync" \
      org.opencontainers.image.licenses="GPL-3.0"

# Surface the build identity at runtime. OCI labels cannot be read from inside a
# running container and package.json only moves at release time, so without these
# a :dev image and a :latest image are indistinguishable in a log (#318).
ENV APP_BUILD_CHANNEL=${VERSION}
ENV APP_BUILD_REF=${VCS_REF}

# System dependencies: BLE (BlueZ + D-Bus), tini (PID 1),
# build-essential (node-gyp needs gcc/g++/make for native BLE modules),
# libffi-dev + libssl-dev + libcurl4-openssl-dev
# (cffi/cryptography/curl_cffi build from source on architectures without
# pre-built wheels, e.g. linux/arm/v7. curl_cffi is a transitive dep of
# garminconnect 0.3.x and has no armv7 wheel on PyPI.), and
# libsqlite3-0 + libreadline8 + libncursesw6: the copied Python's
# lib-dynload brings sqlite3/readline/curses extension modules across, but
# not the system libraries they dlopen — node:22-bookworm-slim doesn't ship
# them, so any dependency that reaches for one (e.g. an sqlite3-backed
# cache) would ImportError at runtime with no build-time signal.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bluez \
      libbluetooth-dev \
      libusb-1.0-0-dev \
      libdbus-1-dev \
      build-essential \
      libffi-dev \
      libssl-dev \
      libcurl4-openssl-dev \
      libsqlite3-0 \
      libreadline8 \
      libncursesw6 \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Python 3.12 (Garmin upload), copied from the python stage above — see the
# comment there for why this isn't just `apt-get install python3`.
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=python /usr/local/lib/libpython3.12.so* /usr/local/lib/
COPY --from=python /usr/local/include/python3.12 /usr/local/include/python3.12
RUN ln -s /usr/local/bin/python3.12 /usr/local/bin/python3 && \
    ln -s /usr/local/bin/python3.12 /usr/local/bin/python && \
    ldconfig

WORKDIR /app

# Python dependencies (Garmin upload). python3 -m pip, not pip3: the
# console-script shims weren't copied from the python stage, only the
# interpreter and site-packages (which already has pip preinstalled).
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt

# Node.js dependencies (production only)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The BLE stacks are optionalDependencies (#364): a node-gyp failure no longer
# fails this build, it just silently drops the package. Without this assertion a
# multi-arch build (linux/arm/v7 in particular) would publish an image whose
# default transport is missing and only fail at runtime.
RUN node -e "for (const p of ['@abandonware/noble','@stoprocent/noble','node-ble','dbus-next']) require.resolve(p + '/package.json');"

# Compiled application
COPY --from=build /app/dist/ ./dist/

# Supporting files
COPY garmin-scripts/ ./garmin-scripts/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Non-root user (UID 1000 from node:22-slim)
# chown /app so the node user can create .tmp files for atomic config writes
RUN chown node:node /app
USER node

# Heartbeat check: /tmp/.ble-scale-sync-heartbeat must be updated within 5 minutes
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD test -f /tmp/.ble-scale-sync-heartbeat && \
      [ "$(find /tmp/.ble-scale-sync-heartbeat -mmin -5 2>/dev/null)" ] || exit 1

ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
CMD ["start"]
