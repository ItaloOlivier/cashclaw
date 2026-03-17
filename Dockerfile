FROM node:20-alpine

WORKDIR /app

# Install moltlaunch CLI globally
RUN npm install -g moltlaunch

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build:all

# CashClaw dashboard port
EXPOSE 3777

# Persistent storage: set CASHCLAW_CONFIG_DIR to Railway volume mount path

# Entrypoint handles config auto-init from CASHCLAW_INIT_CONFIG env var
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create config dirs for non-root user and switch to node
RUN mkdir -p /home/node/.cashclaw /home/node/.moltlaunch \
  && chown -R node:node /home/node/.cashclaw /home/node/.moltlaunch /app

USER node

# Override defaults so Railway env vars pointing to /root/ are replaced
ENV HOME=/home/node \
  CASHCLAW_CONFIG_DIR=/home/node/.cashclaw \
  MOLTLAUNCH_DIR=/home/node/.moltlaunch

CMD ["/app/entrypoint.sh"]
