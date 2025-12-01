#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "Starting Eufy Security Monitor..."

# Read configuration using bashio
export CONNECTION_MODE=$(bashio::config 'connection_mode')
export EUFY_USERNAME=$(bashio::config 'eufy_username')
export EUFY_PASSWORD=$(bashio::config 'eufy_password')
export EUFY_COUNTRY=$(bashio::config 'eufy_country')
export EUFY_WS_URL=$(bashio::config 'eufy_ws_url')
export AI_PROVIDER=$(bashio::config 'ai_provider')
export AI_API_KEY=$(bashio::config 'ai_api_key')
export AI_MODEL=$(bashio::config 'ai_model')
export OLLAMA_URL=$(bashio::config 'ollama_url')
export MONITORING_ENABLED=$(bashio::config 'monitoring_enabled')
export MONITORING_INTERVAL=$(bashio::config 'monitoring_interval')
export TTS_ENABLED=$(bashio::config 'tts_enabled')
export TTS_MEDIA_PLAYER=$(bashio::config 'tts_media_player')

# Home Assistant Supervisor API
export HA_API_URL="http://supervisor/core/api"
export INGRESS_PATH=$(bashio::addon.ingress_entry)

bashio::log.info "Connection Mode: ${CONNECTION_MODE}"
bashio::log.info "AI Provider: ${AI_PROVIDER}"
bashio::log.info "Monitoring Enabled: ${MONITORING_ENABLED}"
bashio::log.info "TTS Enabled: ${TTS_ENABLED}"
bashio::log.info "Ingress Path: ${INGRESS_PATH}"

if [ "${CONNECTION_MODE}" = "ws" ]; then
    bashio::log.info "Using eufy-security-ws at: ${EUFY_WS_URL}"
else
    bashio::log.info "Using direct Eufy connection"
fi

# Create data directory
mkdir -p /config/eufy-monitor

cd /app
exec node server.js
