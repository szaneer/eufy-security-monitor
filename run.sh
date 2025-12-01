#!/usr/bin/env bash
set -e

# Read configuration from Home Assistant addon options.json
CONFIG_PATH="/data/options.json"

if [ -f "$CONFIG_PATH" ]; then
    export EUFY_USERNAME=$(jq -r '.eufy_username // ""' "$CONFIG_PATH")
    export EUFY_PASSWORD=$(jq -r '.eufy_password // ""' "$CONFIG_PATH")
    export EUFY_COUNTRY=$(jq -r '.eufy_country // "US"' "$CONFIG_PATH")
    export AI_PROVIDER=$(jq -r '.ai_provider // "gemini"' "$CONFIG_PATH")
    export AI_API_KEY=$(jq -r '.ai_api_key // ""' "$CONFIG_PATH")
    export AI_MODEL=$(jq -r '.ai_model // "gemini-2.5-flash"' "$CONFIG_PATH")
    export OLLAMA_URL=$(jq -r '.ollama_url // ""' "$CONFIG_PATH")
    export MONITORING_ENABLED=$(jq -r '.monitoring_enabled // false' "$CONFIG_PATH")
    export MONITORING_INTERVAL=$(jq -r '.monitoring_interval // 60' "$CONFIG_PATH")
    export TTS_ENABLED=$(jq -r '.tts_enabled // false' "$CONFIG_PATH")
    export TTS_MEDIA_PLAYER=$(jq -r '.tts_media_player // ""' "$CONFIG_PATH")
else
    echo "Warning: Config file not found at $CONFIG_PATH"
fi

# Home Assistant Supervisor API for TTS (token injected by supervisor)
export HA_API_URL="http://supervisor/core/api"

# Get ingress path from environment (set by supervisor)
export INGRESS_PATH="${INGRESS_ENTRY:-}"

# Create log directory
mkdir -p /config/eufy-monitor

echo "========================================"
echo "Starting Eufy Security Monitor..."
echo "========================================"
echo "Eufy Username: ${EUFY_USERNAME}"
echo "AI Provider: ${AI_PROVIDER}"
echo "Monitoring Enabled: ${MONITORING_ENABLED}"
echo "TTS Enabled: ${TTS_ENABLED}"
echo "Ingress Path: ${INGRESS_PATH}"
echo "========================================"

cd /app
exec node server.js
