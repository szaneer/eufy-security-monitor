#!/bin/bash
# Simple startup script that reads config from options.json

CONFIG_PATH=/data/options.json

# Read configuration using jq
export EUFY_USERNAME=$(jq -r '.eufy_username' $CONFIG_PATH)
export EUFY_PASSWORD=$(jq -r '.eufy_password' $CONFIG_PATH)
export EUFY_COUNTRY=$(jq -r '.eufy_country' $CONFIG_PATH)
export AI_PROVIDER=$(jq -r '.ai_provider' $CONFIG_PATH)
export AI_API_KEY=$(jq -r '.ai_api_key' $CONFIG_PATH)
export AI_MODEL=$(jq -r '.ai_model' $CONFIG_PATH)
export OLLAMA_URL=$(jq -r '.ollama_url' $CONFIG_PATH)
export MONITORING_ENABLED=$(jq -r '.monitoring_enabled' $CONFIG_PATH)
export MONITORING_INTERVAL=$(jq -r '.monitoring_interval' $CONFIG_PATH)
export TTS_ENABLED=$(jq -r '.tts_enabled' $CONFIG_PATH)
export TTS_MEDIA_PLAYER=$(jq -r '.tts_media_player' $CONFIG_PATH)

# Home Assistant Supervisor API for TTS
export HA_API_URL="http://supervisor/core/api"

# Get ingress path from environment or default
export INGRESS_PATH="${INGRESS_PATH:-/}"

# Create log directory
mkdir -p /config/eufy-monitor

echo "Starting Eufy Security Monitor..."
echo "Eufy Username: ${EUFY_USERNAME}"
echo "AI Provider: ${AI_PROVIDER}"
echo "Monitoring Enabled: ${MONITORING_ENABLED}"
echo "TTS Enabled: ${TTS_ENABLED}"

cd /app
exec node server.js
