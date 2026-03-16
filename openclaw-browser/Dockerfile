FROM ghcr.io/openclaw/openclaw:latest

USER root

# Install Chromium + Xvfb for browser automation
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
    mkdir -p /home/node/.cache/ms-playwright && \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
    node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
    chown -R node:node /home/node/.cache/ms-playwright && \
    rm -rf /var/lib/apt/lists/*

# Write OpenClaw config for both possible home dirs (node user vs root)
RUN mkdir -p /root/.openclaw /home/node/.openclaw
COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /home/node/.openclaw/openclaw.json
RUN chown -R node:node /home/node/.openclaw

USER node

# bind=custom + customBindHost=0.0.0.0 in config ensures Railway networking works
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
