#!/command/with-contenv bashio

# Read configuration from Home Assistant
export EUFY_USERNAME=$(bashio::config 'eufy_username')
export EUFY_PASSWORD=$(bashio::config 'eufy_password')
export EUFY_COUNTRY=$(bashio::config 'eufy_country')
export AI_PROVIDER=$(bashio::config 'ai_provider')
export AI_API_KEY=$(bashio::config 'ai_api_key')
export AI_MODEL=$(bashio::config 'ai_model')
export OLLAMA_URL=$(bashio::config 'ollama_url')
export MONITORING_ENABLED=$(bashio::config 'monitoring_enabled')
export MONITORING_INTERVAL=$(bashio::config 'monitoring_interval')
export TTS_ENABLED=$(bashio::config 'tts_enabled')
export TTS_MEDIA_PLAYER=$(bashio::config 'tts_media_player')

# Home Assistant Supervisor API for TTS
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
export HA_API_URL="http://supervisor/core/api"

# Set ingress path for proper URL routing
export INGRESS_PATH=$(bashio::addon.ingress_entry)

# Create log directory
mkdir -p /config/eufy-monitor

bashio::log.info "Starting Eufy Security Monitor..."
bashio::log.info "Eufy Username: ${EUFY_USERNAME}"
bashio::log.info "AI Provider: ${AI_PROVIDER}"
bashio::log.info "Monitoring Enabled: ${MONITORING_ENABLED}"
bashio::log.info "TTS Enabled: ${TTS_ENABLED}"
bashio::log.info "Ingress Path: ${INGRESS_PATH}"

cd /app
exec node server.js
