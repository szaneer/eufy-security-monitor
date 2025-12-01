# Eufy Security Monitor - Home Assistant Addon

AI-powered monitoring for Eufy security cameras with TTS alerts.

## Features

- **Live Camera Streams** - View all your Eufy cameras in a dashboard
- **AI-Powered Analysis** - Ask questions about what's happening on your cameras using Gemini, OpenAI, or local Ollama
- **Event Monitoring** - Automatic detection of motion, persons, vehicles, pets, and doorbell rings
- **TTS Alerts** - Announce unusual events on your Home Assistant media players
- **Battery Efficient** - Uses cached images and push notifications, not continuous streaming

## Installation

### Option 1: Add Repository to Home Assistant

1. Go to **Settings** → **Add-ons** → **Add-on Store**
2. Click the **⋮** menu (top right) → **Repositories**
3. Add: `https://github.com/szaneer/eufy-security-monitor`
4. Find "Eufy Security Monitor" in the store and click **Install**

### Option 2: Manual Installation

1. Clone this repository into your Home Assistant `addons` folder:
   ```bash
   cd /addons
   git clone https://github.com/szaneer/eufy-security-monitor
   ```
2. Go to **Settings** → **Add-ons** → **Add-on Store**
3. Click **⟳** to refresh
4. Find "Eufy Security Monitor" and install

## Configuration

```yaml
eufy_username: "your_eufy_email@example.com"
eufy_password: "your_eufy_password"
eufy_country: "US"
ai_provider: "gemini"  # Options: gemini, openai, ollama
ai_api_key: "your_api_key"
ai_model: "gemini-2.5-flash"
monitoring_enabled: true
monitoring_interval: 60  # minutes (0 to disable periodic checks)
tts_enabled: false
tts_media_player: "media_player.living_room"
```

### AI Provider Options

#### Google Gemini (Recommended)
- Get an API key from [Google AI Studio](https://aistudio.google.com/)
- Models: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`

#### OpenAI
- Get an API key from [OpenAI Platform](https://platform.openai.com/)
- Models: `gpt-4o`, `gpt-4o-mini`

#### Ollama (Local)
- Requires Ollama running on your network
- Set `ollama_url` to your Ollama server (e.g., `http://192.168.1.100:11434/api/generate`)
- Models: `qwen3-vl:8b`, `llava:7b`, etc.

## Usage

### Dashboard Access

After starting the addon, access the dashboard from:
- Home Assistant sidebar: **Eufy Monitor**
- Or directly at: `http://homeassistant.local:3000`

### Live Streaming

1. Click **Dashboard View** to see all cameras
2. Click **Start All Streams** for WiFi cameras
3. For HomeBase cameras, click **Play** on individual cameras (HomeBase supports 1 stream at a time)

### AI Queries

1. In the dashboard, use the AI query box
2. Ask questions like:
   - "Is there anyone in the backyard?"
   - "What's happening at the front door?"
   - "Are all the garage doors closed?"

### Event Monitoring

When enabled, the addon will:
1. Listen for push notifications from Eufy (motion, person detected, etc.)
2. Analyze the event with AI
3. Log all events to `/config/eufy-monitor/events.log`
4. If configured, announce unusual events via TTS

## TTS Alerts

When TTS is enabled, the addon will announce alerts for unusual events:
- Unknown person at door
- Suspicious activity
- Unexpected vehicles

Normal events (deliveries, pets, family members) are logged but not announced.

### Setting Up TTS

1. In addon settings, set `tts_enabled: true`
2. Set `tts_media_player` to your speaker entity (e.g., `media_player.kitchen`)
3. Ensure your Home Assistant has a TTS service configured (Google, Amazon Polly, etc.)

## Event Log

Events are logged to `/config/eufy-monitor/events.log`:

```
[2025-11-30T10:15:32.123Z] Front Door | PERSON | Delivery person in brown uniform holding a package.
[2025-11-30T10:18:45.456Z] Backyard | MOTION | Squirrel running across the lawn.
[2025-11-30T11:02:12.789Z] Front Door | DOORBELL_RING [UNUSUAL] | Unknown person at door, no visible package.
```

## Supported Devices

This addon supports all Eufy cameras and doorbells that work with the eufy-security-client library, including:
- eufyCam series (2, 2C, 3, 3C)
- SoloCam series (E20, E40, L20, L40, S40, S340)
- Indoor Cam series
- Video Doorbells
- Floodlight Cameras
- And more...

## Troubleshooting

### Addon won't start
- Check that your Eufy credentials are correct
- Ensure 2FA is disabled on your Eufy account, or use the web login method

### No video stream
- Some cameras require the HomeBase to be awake
- Try triggering motion on the camera first

### TTS not working
- Verify your `tts_media_player` entity is correct
- Check Home Assistant logs for TTS errors

## License

MIT License
