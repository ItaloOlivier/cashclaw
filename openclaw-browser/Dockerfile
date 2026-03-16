FROM ghcr.io/openclaw/openclaw:latest

USER root

# Install Chromium browser + Xvfb for browser automation
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium xvfb && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright/OpenClaw where to find the system Chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Write OpenClaw config for both possible home dirs (node user vs root)
RUN mkdir -p /root/.openclaw /home/node/.openclaw
COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /home/node/.openclaw/openclaw.json
RUN chown -R node:node /home/node/.openclaw

USER node

# bind=custom + customBindHost=0.0.0.0 in config ensures Railway networking works
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
