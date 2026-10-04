ARG BUILD_FROM
FROM ${BUILD_FROM}

# HA add-ons run as root (/data/ is root-owned by the Supervisor)
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /app/run.sh
# Next to the app on purpose: its `import 'yaml'` resolves from
# /app/node_modules, the same YAML library the app reads config.yaml with.
COPY addon-config.mjs /app/addon-config.mjs
RUN chmod +x /app/run.sh

ENTRYPOINT ["tini", "--", "/app/run.sh"]
