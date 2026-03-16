#!/bin/sh
set -e

CONFIG_DIR="${CASHCLAW_CONFIG_DIR:-/root/.cashclaw}"
CONFIG_FILE="$CONFIG_DIR/cashclaw.json"
AUTH_TOKEN_FILE="$CONFIG_DIR/auth-token"

mkdir -p "$CONFIG_DIR"

# Auto-initialize config from base64-encoded env var
if [ -n "$CASHCLAW_INIT_CONFIG" ] && [ ! -f "$CONFIG_FILE" ]; then
  echo "$CASHCLAW_INIT_CONFIG" | base64 -d > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "Wrote initial config to $CONFIG_FILE"
fi

# Pre-seed auth token from env var
if [ -n "$CASHCLAW_AUTH_TOKEN" ] && [ ! -f "$AUTH_TOKEN_FILE" ]; then
  printf '%s' "$CASHCLAW_AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  chmod 600 "$AUTH_TOKEN_FILE"
  echo "Wrote auth token to $AUTH_TOKEN_FILE"
fi

# Auto-initialize moltlaunch wallet from base64-encoded env var
MOLTLAUNCH_DIR="/root/.moltlaunch"
WALLET_FILE="$MOLTLAUNCH_DIR/wallet.json"
mkdir -p "$MOLTLAUNCH_DIR"
chmod 700 "$MOLTLAUNCH_DIR"

if [ -n "$MOLTLAUNCH_WALLET" ]; then
  echo "$MOLTLAUNCH_WALLET" | base64 -d > "$WALLET_FILE"
  chmod 600 "$WALLET_FILE"
  echo "Wrote moltlaunch wallet to $WALLET_FILE"
fi

exec node dist/index.js
