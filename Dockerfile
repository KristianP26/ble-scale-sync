# ── Build stage: compile TypeScript ──────────────────────────────────
# Base images are pinned by digest (the multi-arch index), so two builds of
# the same commit get the same base. Dependabot (docker ecosystem) moves the
# digests; keep the three node:22 references (build, native and runtime
# stages) in step when bumping by hand.
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build

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
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS python

# ── Native stage: compile dependencies for the target platform ───────
# The native BLE modules (node-gyp) and the Python packages without a wheel
# for the target are compiled here, so the compiler and the -dev headers stay
# out of the runtime image. Only node_modules and the Python tree go across.
# Same base as the runtime stage: the compiled code links against its glibc.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS native

# build-essential: node-gyp needs gcc/g++/make for the native BLE modules.
# libffi-dev + libssl-dev + libcurl4-openssl-dev: cffi/cryptography/curl_cffi
# build from source on architectures without pre-built wheels, e.g.
# linux/arm/v7 (curl_cffi is a transitive dep of garminconnect 0.3.x and has
# no armv7 wheel on PyPI).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libbluetooth-dev \
      libusb-1.0-0-dev \
      libdbus-1-dev \
      libffi-dev \
      libssl-dev \
      libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Python 3.12 (see the python stage), headers included for the source builds.
# node-gyp needs a Python as well, so this comes before npm ci.
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=python /usr/local/lib/libpython3.12.so* /usr/local/lib/
COPY --from=python /usr/local/include/python3.12 /usr/local/include/python3.12
RUN ln -s /usr/local/bin/python3.12 /usr/local/bin/python3 && \
    ln -s /usr/local/bin/python3.12 /usr/local/bin/python && \
    ldconfig

WORKDIR /app

# Python dependencies (Garmin upload), installed into the copied interpreter's
# own site-packages. python3 -m pip, not pip3: the console-script shims were
# not copied from the python stage, only the interpreter and site-packages
# (which already has pip preinstalled).
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt

# Node.js dependencies (production only)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

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

# System dependencies: BLE (BlueZ + D-Bus), tini (PID 1), and the shared
# libraries the code compiled in the native stage links against, without the
# compiler and headers: libbluetooth3 + libusb-1.0-0 + libdbus-1-3 (native BLE
# modules), libffi8 + libssl3 + libcurl4 (cffi/cryptography/curl_cffi when
# built from source, and the copied Python's own _ctypes/_ssl/_hashlib).
# libsqlite3-0 + libreadline8 + libncursesw6 + libgdbm6 + libnsl2: the copied
# Python's lib-dynload brings sqlite3/readline/curses/dbm.gnu/nis extension
# modules across, but not the system libraries they dlopen (the last two came
# in with the compiler toolchain before it left this stage, so they are
# listed to keep the module set the image always had). node:22-bookworm-slim
# ships none of these, so a
# missing one would only show up as an ImportError or a failed dlopen at
# runtime; the ldd check further down turns that into a build failure.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bluez \
      libbluetooth3 \
      libusb-1.0-0 \
      libdbus-1-3 \
      libffi8 \
      libssl3 \
      libcurl4 \
      libsqlite3-0 \
      libreadline8 \
      libncursesw6 \
      libgdbm6 \
      libnsl2 \
      tini \
      rfkill \
      libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_admin+ep /usr/bin/btmgmt

# Why btmgmt carries a file capability. The container runs as USER node (below),
# and Docker gives a non-root process no effective capabilities at all: the
# documented `--cap-add NET_ADMIN` only widens the bounding set. Without this,
# `btmgmt power off/on` is refused by the kernel (the mgmt SET_POWERED command
# needs CAP_NET_ADMIN), so the entrypoint reset, the preemptive power-cycle
# after each GATT session and the btmgmt recovery tier all failed silently.
# The file capability is masked by the bounding set, so it grants nothing the
# operator did not already grant with --cap-add NET_ADMIN; without that flag
# exec of btmgmt fails with EPERM, the same "reset failed" outcome as before.
# It also does nothing under --security-opt no-new-privileges. Only btmgmt is
# marked, not node: a capability on node would put every node process in
# secure-execution mode and make it unrunnable without --cap-add.
#
# rfkill backs the last recovery tier (block/unblock). It needs no capability,
# only write access to /dev/rfkill, which comes from the device node the host
# passes in (docker-compose.example.yml maps it). As USER node that also needs
# the device to be writable by one of the container's groups, so for a non-root
# container this tier still depends on how the host sets up /dev/rfkill.

# Python 3.12 (Garmin upload) with the Garmin packages already installed, from
# the native stage. The interpreter comes from the python stage; see the
# comment there for why this isn't just `apt-get install python3`. The C
# headers stay behind: nothing compiles here.
COPY --from=native /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=native /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=native /usr/local/lib/libpython3.12.so* /usr/local/lib/
RUN ln -s /usr/local/bin/python3.12 /usr/local/bin/python3 && \
    ln -s /usr/local/bin/python3.12 /usr/local/bin/python && \
    ldconfig

WORKDIR /app

# Node.js dependencies (production only), compiled in the native stage.
COPY package.json package-lock.json ./
COPY --from=native /app/node_modules ./node_modules

# Every shared library the compiled code and the Python tree link against must
# exist here, now that the -dev packages (which used to pull them in) are gone.
# Prebuilds for musl and for Android, and _tkinter (no Tk in this image, and
# nothing imports it), are the only expected gaps. A foreign-architecture
# prebuild is "not a dynamic executable" to ldd and never reports a gap, but an
# Android prebuild for the build's own CPU (android-arm64 on arm64,
# android-arm on arm/v7) is a readable ELF that links Bionic (liblog.so,
# libc++_shared.so) and is never loaded on Linux, so it is skipped by path.
RUN missing=$(find /app/node_modules /usr/local/lib/python3.12 -type f \
      \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) \
      ! -name '*musl*' ! -name '_tkinter*' ! -path '*/prebuilds/android-*' \
      -exec sh -c 'for f; do ldd "$f" 2>/dev/null | grep "not found" | sed "s|^|$f: |"; done; exit 0' sh {} +) && \
    if [ -n "$missing" ]; then echo "Missing shared libraries:"; echo "$missing"; exit 1; fi

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
