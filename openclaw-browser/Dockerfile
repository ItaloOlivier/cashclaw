FROM ghcr.io/openclaw/openclaw:latest

USER root

# Write OpenClaw config for both possible home dirs (node user vs root)
RUN mkdir -p /root/.openclaw /home/node/.openclaw
COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /home/node/.openclaw/openclaw.json
RUN chown -R node:node /home/node/.openclaw

# bind=custom + customBindHost=0.0.0.0 in config ensures Railway networking works
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
