FROM node:20-alpine

WORKDIR /app

# Install su-exec for privilege drop
# moltlaunch is not installed globally — workspace:* deps break npm global install.
# The app reads wallet.json directly; the mltl CLI is not needed at runtime.
RUN apk add --no-cache su-exec

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build:all

# CashClaw dashboard port
EXPOSE 3777

# Create config dirs for non-root user
RUN mkdir -p /home/node/.cashclaw /home/node/.moltlaunch \
  && chown -R node:node /home/node/.cashclaw /home/node/.moltlaunch /app

# Do NOT set USER node — entrypoint handles privilege drop after fixing volume permissions

ENV HOME=/home/node \
  CASHCLAW_CONFIG_DIR=/home/node/.cashclaw \
  MOLTLAUNCH_DIR=/home/node/.moltlaunch

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
