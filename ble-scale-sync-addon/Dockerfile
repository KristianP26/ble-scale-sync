ARG BUILD_FROM
FROM ${BUILD_FROM}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq curl \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

USER node

ENTRYPOINT ["tini", "--", "/app/run.sh"]
