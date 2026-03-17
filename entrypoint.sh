#!/bin/sh
set -e

CONFIG_DIR="${CASHCLAW_CONFIG_DIR:-$HOME/.cashclaw}"
CONFIG_FILE="$CONFIG_DIR/cashclaw.json"
AUTH_TOKEN_FILE="$CONFIG_DIR/auth-token"

mkdir -p "$CONFIG_DIR"

# Always seed config from base64 env var (no persistent volume = fresh each deploy)
if [ -n "$CASHCLAW_INIT_CONFIG" ]; then
  echo "$CASHCLAW_INIT_CONFIG" | base64 -d > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "Wrote config to $CONFIG_FILE"
fi

# Always seed auth token from env var
if [ -n "$CASHCLAW_AUTH_TOKEN" ]; then
  printf '%s' "$CASHCLAW_AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  chmod 600 "$AUTH_TOKEN_FILE"
  echo "Wrote auth token to $AUTH_TOKEN_FILE"
fi

# Always seed moltlaunch wallet from base64 env var
MOLTLAUNCH_DIR="${MOLTLAUNCH_DIR:-$HOME/.moltlaunch}"
WALLET_FILE="$MOLTLAUNCH_DIR/wallet.json"
mkdir -p "$MOLTLAUNCH_DIR"
chmod 700 "$MOLTLAUNCH_DIR"

if [ -n "$MOLTLAUNCH_WALLET" ]; then
  echo "$MOLTLAUNCH_WALLET" | base64 -d > "$WALLET_FILE"
  chmod 600 "$WALLET_FILE"
  echo "Wrote moltlaunch wallet to $WALLET_FILE"
fi

exec node dist/index.js
