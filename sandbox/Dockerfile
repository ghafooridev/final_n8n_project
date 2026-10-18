FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git ca-certificates python3 python3-pip python3-venv python3-pytest procps \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python

# Agent code runs as this unprivileged user; the API server keeps task state where it cannot write.
RUN groupadd -g 1001 runner \
  && useradd -m -u 1001 -g 1001 -s /bin/bash runner \
  && mkdir -p /workspaces /data \
  && chown runner:runner /workspaces \
  && chmod 700 /data

WORKDIR /app
COPY server.js /app/server.js

ENV PORT=8080 \
    WORKSPACES_DIR=/workspaces \
    DATA_DIR=/data \
    RUNNER_HOME=/home/runner

EXPOSE 8080
CMD ["node", "/app/server.js"]
