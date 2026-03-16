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

CMD ["node", "dist/index.js"]
