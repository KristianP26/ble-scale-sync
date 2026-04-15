ARG BUILD_FROM
FROM ${BUILD_FROM}

# HA add-ons run as root (/data/ is root-owned by the Supervisor)
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /app/run.sh
COPY merge_last_weights.py /app/merge_last_weights.py
RUN chmod +x /app/run.sh /app/merge_last_weights.py

ENTRYPOINT ["tini", "--", "/app/run.sh"]
