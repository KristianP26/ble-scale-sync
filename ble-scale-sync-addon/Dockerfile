ARG BUILD_FROM
FROM ${BUILD_FROM}

# HA add-ons run as root (/data/ is root-owned by the Supervisor)
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENTRYPOINT ["tini", "--", "/app/run.sh"]
