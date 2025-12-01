/**
 * Eufy Security Monitor - Home Assistant Addon
 * AI-powered monitoring for Eufy cameras with TTS alerts
 */

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

// Import eufy-security-client (for direct mode)
const { EufySecurity, P2PConnectionType, Device, PropertyName } = require("eufy-security-client");

const app = express();
const httpServer = createServer(app);

const PORT = 3000;

// Connection mode: "direct" or "ws" (eufy-security-ws)
const connectionMode = process.env.CONNECTION_MODE || "direct";
const eufyWsUrl = process.env.EUFY_WS_URL || "ws://addon_eufy-security-ws:3000";

// Persistent storage directory for Eufy auth tokens (direct mode only)
const persistentDir = process.env.PERSISTENT_DIR || "/config/eufy-monitor";

// Configuration for direct mode
const config = {
    username: process.env.EUFY_USERNAME || "",
    password: process.env.EUFY_PASSWORD || "",
    country: process.env.EUFY_COUNTRY || "US",
    language: "en",
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    pollingIntervalMinutes: 10,
    eventDurationSeconds: 10,
    persistentDir: persistentDir,
};

// WebSocket client for eufy-security-ws mode
let wsClient = null;
let wsMessageId = 1;
let wsPendingRequests = new Map();
let wsStreamProcesses = new Map(); // Track ffmpeg processes for WS streams

// AI Settings from environment
let aiSettings = {
    provider: process.env.AI_PROVIDER || "gemini",
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434/api/generate",
    ollamaModel: process.env.AI_MODEL || "qwen3-vl:8b",
    openaiApiKey: process.env.AI_API_KEY || "",
    openaiModel: process.env.AI_MODEL || "gpt-4o",
    geminiApiKey: process.env.AI_API_KEY || "",
    geminiModel: process.env.AI_MODEL || "gemini-2.5-flash",
};

// Monitoring settings
let monitoringSettings = {
    enabled: process.env.MONITORING_ENABLED === "true",
    periodicInterval: parseInt(process.env.MONITORING_INTERVAL || "60"),
    eventTypes: ["all"],
    logFilePath: process.env.LOG_FILE_PATH || "/config/eufy-monitor/events.log",
};

// TTS settings
let ttsSettings = {
    enabled: process.env.TTS_ENABLED === "true",
    mediaPlayer: process.env.TTS_MEDIA_PLAYER || "",
};

// Home Assistant API
const haApiUrl = process.env.HA_API_URL || "http://supervisor/core/api";
const supervisorToken = process.env.SUPERVISOR_TOKEN || "";
const ingressPath = process.env.INGRESS_PATH || "";

// For HA ingress, we serve at / - HA handles the path rewriting
// The ingressPath is passed to the frontend for correct link generation
const basePath = "";

// Socket.IO - serve at default path, HA handles ingress routing
const io = new Server(httpServer, {
    path: "/socket.io",
});

let eufy = null;
let currentSocket = null;

// Stream state
let ffmpegProcess = null;
let currentStreamDevice = null;
let jpegBuffer = Buffer.alloc(0);

// Dashboard multi-stream state
const dashboardStreams = new Map();
let isDashboardMode = false;

// AI Query state
let currentAIQuery = null;
const aiQueryStreams = new Map();

// Store devices when they're added via events
const deviceMap = new Map();

// Monitoring state
let periodicTimer = null;
let eventQueue = [];
let isProcessingEvent = false;

// Track active P2P sessions per HomeBase to prevent conflicts
// Key: stationSerial, Value: { deviceSerial, type, startTime }
const activeP2PSessions = new Map();

// ==================== TTS FUNCTIONS ====================

async function announceToHomeAssistant(message) {
    if (!ttsSettings.enabled || !ttsSettings.mediaPlayer) {
        console.log("[TTS] TTS disabled or no media player configured");
        return;
    }

    if (!supervisorToken) {
        console.log("[TTS] No supervisor token available - not running in HA addon");
        return;
    }

    // Sanitize message - remove any JSON artifacts or special characters
    const cleanMessage = message
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .replace(/[{}"\[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 250); // Keep it reasonably short for TTS

    console.log(`[TTS] Attempting to announce: "${cleanMessage}" on ${ttsSettings.mediaPlayer}`);

    // Try legacy services first (they work with just media_player entity)
    // Then try modern tts.speak (requires separate tts entity)
    const ttsServices = [
        {
            name: "tts.google_translate_say",
            endpoint: `${haApiUrl}/services/tts/google_translate_say`,
            body: {
                entity_id: ttsSettings.mediaPlayer,
                message: cleanMessage,
            },
        },
        {
            name: "tts.cloud_say",
            endpoint: `${haApiUrl}/services/tts/cloud_say`,
            body: {
                entity_id: ttsSettings.mediaPlayer,
                message: cleanMessage,
            },
        },
        {
            name: "tts.piper_say",
            endpoint: `${haApiUrl}/services/tts/piper_say`,
            body: {
                entity_id: ttsSettings.mediaPlayer,
                message: cleanMessage,
            },
        },
        {
            name: "tts.speak (default)",
            endpoint: `${haApiUrl}/services/tts/speak`,
            body: {
                media_player_entity_id: ttsSettings.mediaPlayer,
                message: cleanMessage,
            },
        },
    ];

    for (const service of ttsServices) {
        try {
            console.log(`[TTS] Trying ${service.name}...`);
            const response = await fetch(service.endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${supervisorToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(service.body),
            });

            if (response.ok) {
                console.log(`[TTS] Success with ${service.name}: "${message}"`);
                return;
            } else {
                const errorText = await response.text();
                console.log(`[TTS] ${service.name} returned ${response.status}: ${errorText}`);
            }
        } catch (err) {
            console.log(`[TTS] ${service.name} error: ${err.message}`);
        }
    }

    console.error("[TTS] All TTS services failed. Check your HA TTS configuration.");
}

// ==================== AI FUNCTIONS ====================

function buildPrompt(query, cameraList) {
    return `You are analyzing live camera feeds from the following cameras: ${cameraList}.
The user asks: "${query}"
Please analyze the images and provide a concise, helpful response about what you see.`;
}

// Non-streaming AI query for event monitoring
async function queryAINonStreaming(prompt, frames) {
    const images = frames.map(f => f.frame.toString("base64"));

    switch (aiSettings.provider) {
        case "ollama":
            return await queryOllamaNonStreaming(prompt, images);
        case "openai":
            return await queryOpenAINonStreaming(prompt, frames);
        case "gemini":
            return await queryGeminiNonStreaming(prompt, frames);
        default:
            throw new Error(`Unknown AI provider: ${aiSettings.provider}`);
    }
}

async function queryOllamaNonStreaming(prompt, images) {
    const response = await fetch(aiSettings.ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: aiSettings.ollamaModel,
            prompt: `/no_think ${prompt}`,
            images: images,
            stream: false,
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    return data.response || "";
}

async function queryOpenAINonStreaming(prompt, frames) {
    if (!aiSettings.openaiApiKey) {
        throw new Error("OpenAI API key not configured");
    }

    const imageContents = frames.map(f => ({
        type: "image_url",
        image_url: {
            url: `data:image/jpeg;base64,${f.frame.toString("base64")}`,
        },
    }));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${aiSettings.openaiApiKey}`,
        },
        body: JSON.stringify({
            model: aiSettings.openaiModel,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        ...imageContents,
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
}

async function queryGeminiNonStreaming(prompt, frames) {
    if (!aiSettings.geminiApiKey) {
        throw new Error("Gemini API key not configured");
    }

    const parts = [{ text: prompt }];
    for (const frame of frames) {
        parts.push({
            inline_data: {
                mime_type: "image/jpeg",
                data: frame.frame.toString("base64"),
            },
        });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiSettings.geminiModel}:generateContent?key=${aiSettings.geminiApiKey}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts }],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Streaming AI queries (for interactive use)
async function queryOllamaStreaming(query, frames, socket) {
    const images = frames.map(f => f.frame.toString("base64"));
    const cameraList = frames.map(f => f.cameraName).join(", ");
    const prompt = `/no_think ${buildPrompt(query, cameraList)}`;

    console.log(`[AI] Querying Ollama (${aiSettings.ollamaModel}) with ${frames.length} frames`);

    const response = await fetch(aiSettings.ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: aiSettings.ollamaModel,
            prompt: prompt,
            images: images,
            stream: true,
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
        throw new Error("No response body from Ollama");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let isFirstChunk = true;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.response) {
                    if (isFirstChunk) {
                        socket.emit("ai-progress", `AI is responding...`);
                        isFirstChunk = false;
                    }
                    socket.emit("ai-response-chunk", json.response);
                }
            } catch {
                // Ignore parse errors for partial lines
            }
        }
    }
}

async function queryOpenAIStreaming(query, frames, socket) {
    const cameraList = frames.map(f => f.cameraName).join(", ");
    const prompt = buildPrompt(query, cameraList);

    console.log(`[AI] Querying OpenAI (${aiSettings.openaiModel}) with ${frames.length} frames`);

    const imageContents = frames.map(f => ({
        type: "image_url",
        image_url: {
            url: `data:image/jpeg;base64,${f.frame.toString("base64")}`,
        },
    }));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${aiSettings.openaiApiKey}`,
        },
        body: JSON.stringify({
            model: aiSettings.openaiModel,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        ...imageContents,
                    ],
                },
            ],
            stream: true,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let isFirstChunk = true;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(line => line.startsWith("data: "));

        for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                    if (isFirstChunk) {
                        socket.emit("ai-progress", `AI is responding...`);
                        isFirstChunk = false;
                    }
                    socket.emit("ai-response-chunk", content);
                }
            } catch {
                // Ignore parse errors
            }
        }
    }
}

async function queryGeminiStreaming(query, frames, socket) {
    const cameraList = frames.map(f => f.cameraName).join(", ");
    const prompt = buildPrompt(query, cameraList);

    console.log(`[AI] Querying Gemini (${aiSettings.geminiModel}) with ${frames.length} frames`);

    const parts = [{ text: prompt }];
    for (const frame of frames) {
        parts.push({
            inline_data: {
                mime_type: "image/jpeg",
                data: frame.frame.toString("base64"),
            },
        });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiSettings.geminiModel}:streamGenerateContent?alt=sse&key=${aiSettings.geminiApiKey}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts }],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let isFirstChunk = true;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(line => line.startsWith("data: "));

        for (const line of lines) {
            const data = line.slice(6);
            try {
                const json = JSON.parse(data);
                const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                    if (isFirstChunk) {
                        socket.emit("ai-progress", `AI is responding...`);
                        isFirstChunk = false;
                    }
                    socket.emit("ai-response-chunk", text);
                }
            } catch {
                // Ignore parse errors
            }
        }
    }
}

async function queryAIStreaming(query, frames, socket, startTime) {
    switch (aiSettings.provider) {
        case "ollama":
            await queryOllamaStreaming(query, frames, socket);
            break;
        case "openai":
            if (!aiSettings.openaiApiKey) {
                throw new Error("OpenAI API key not configured");
            }
            await queryOpenAIStreaming(query, frames, socket);
            break;
        case "gemini":
            if (!aiSettings.geminiApiKey) {
                throw new Error("Gemini API key not configured");
            }
            await queryGeminiStreaming(query, frames, socket);
            break;
        default:
            throw new Error(`Unknown AI provider: ${aiSettings.provider}`);
    }

    const totalDuration = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : null;
    socket.emit("ai-response-done", { duration: totalDuration, provider: aiSettings.provider });
}

// ==================== EUFY-SECURITY-WS CLIENT ====================

// Send a command to eufy-security-ws and wait for response
function sendWsCommand(command, args = {}) {
    return new Promise((resolve, reject) => {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            reject(new Error("WebSocket not connected"));
            return;
        }

        const messageId = `msg_${wsMessageId++}`;
        const message = {
            messageId,
            command,
            ...args,
        };

        const timeout = setTimeout(() => {
            wsPendingRequests.delete(messageId);
            reject(new Error(`Timeout waiting for response to ${command}`));
        }, 30000);

        wsPendingRequests.set(messageId, { resolve, reject, timeout });
        wsClient.send(JSON.stringify(message));
    });
}

// Initialize connection to eufy-security-ws
async function initializeEufyWs() {
    console.log(`[WS] Connecting to eufy-security-ws at ${eufyWsUrl}...`);

    return new Promise((resolve, reject) => {
        wsClient = new WebSocket(eufyWsUrl);

        wsClient.on("open", async () => {
            console.log("[WS] Connected to eufy-security-ws!");

            try {
                // Set the API schema version
                const versionResult = await sendWsCommand("set_api_schema", { schemaVersion: 13 });
                console.log("[WS] API schema set:", versionResult);

                // Start listening for events - this returns the full state including stations and devices
                const stateResult = await sendWsCommand("start_listening");
                console.log("[WS] Started listening for events");

                // Parse stations and devices from the state result
                const state = stateResult?.result?.state || stateResult?.state || {};
                const driver = state.driver || {};

                console.log("[WS] State received:", JSON.stringify(state, null, 2).substring(0, 500));

                // Get stations
                const stations = driver.stations || state.stations || [];
                console.log(`[WS] Found ${Object.keys(stations).length || stations.length || 0} stations`);

                // Stations might be an object keyed by serial number
                const stationList = Array.isArray(stations) ? stations : Object.values(stations);

                // Debug: log first station structure
                if (stationList.length > 0) {
                    console.log("[WS] First station keys:", Object.keys(stationList[0]));
                }

                for (const station of stationList) {
                    const stationName = station.name || station.stationName || station.properties?.name?.value;
                    const stationSerial = station.serialNumber || station.serial || station.properties?.serialNumber?.value;
                    console.log(`[WS] Station: ${stationName} (${stationSerial})`);
                }

                // Get devices - might be an object keyed by serial number
                const devices = driver.devices || state.devices || [];
                const deviceList = Array.isArray(devices) ? devices : Object.values(devices);
                console.log(`[WS] Found ${deviceList.length} devices`);

                // Debug: log first device structure
                if (deviceList.length > 0) {
                    console.log("[WS] First device keys:", Object.keys(deviceList[0]));
                    console.log("[WS] First device:", JSON.stringify(deviceList[0], null, 2).substring(0, 1000));
                }

                for (const device of deviceList) {
                    // Try various possible property names
                    const serialNumber = device.serialNumber || device.serial_number || device.serial || device.properties?.serialNumber?.value;
                    const name = device.name || device.deviceName || device.properties?.name?.value;
                    const model = device.model || device.deviceModel || device.properties?.model?.value;
                    const type = device.type || device.deviceType || device.properties?.type?.value;
                    const stationSN = device.stationSerialNumber || device.station_serial_number || device.stationSN || device.properties?.stationSerialNumber?.value;

                    console.log(`[WS] Device: ${name} (${model}) - Serial: ${serialNumber}`);

                    // Create a device-like object for our deviceMap
                    const deviceObj = {
                        serial: serialNumber,
                        name: name,
                        model: model,
                        type: type,
                        stationSN: stationSN,
                        properties: device.properties || {},
                        // Helper methods to match eufy-security-client API
                        getSerial: () => serialNumber,
                        getName: () => name,
                        getRawDevice: () => ({
                            device_model: model,
                            device_type: type,
                            station_sn: stationSN,
                        }),
                        getStationSerial: () => stationSN,
                        getPropertyValue: (prop) => device.properties?.[prop]?.value,
                    };

                    deviceMap.set(serialNumber, deviceObj);
                }

                resolve();
            } catch (err) {
                console.error("[WS] Error during initialization:", err);
                reject(err);
            }
        });

        wsClient.on("message", (data, isBinary) => {
            // Handle binary video data
            if (isBinary) {
                if (currentStreamDevice) {
                    const ffmpeg = wsStreamProcesses.get(currentStreamDevice);
                    if (ffmpeg && ffmpeg.stdin) {
                        try {
                            ffmpeg.stdin.write(data);
                        } catch (err) {
                            console.error("[WS] Error writing binary video data:", err.message);
                        }
                    }
                }
                return;
            }

            try {
                const message = JSON.parse(data.toString());

                // Handle responses to our commands
                if (message.messageId && wsPendingRequests.has(message.messageId)) {
                    const { resolve, reject, timeout } = wsPendingRequests.get(message.messageId);
                    clearTimeout(timeout);
                    wsPendingRequests.delete(message.messageId);

                    if (message.errorCode) {
                        reject(new Error(message.errorCode));
                    } else {
                        resolve(message);
                    }
                    return;
                }

                // Handle events
                if (message.type === "event") {
                    handleWsEvent(message);
                }
            } catch (err) {
                console.error("[WS] Error parsing message:", err);
            }
        });

        wsClient.on("error", (error) => {
            console.error("[WS] WebSocket error:", error);
            reject(error);
        });

        wsClient.on("close", () => {
            console.log("[WS] WebSocket connection closed");
            wsClient = null;
        });
    });
}

// Handle events from eufy-security-ws
function handleWsEvent(message) {
    const { event, source, serialNumber } = message;

    switch (event) {
        case "device motion detected":
        case "device person detected":
        case "device pet detected":
        case "device vehicle detected":
        case "device sound detected":
        case "device doorbell rings": {
            const device = deviceMap.get(serialNumber);
            if (device && monitoringSettings.enabled) {
                const eventType = event.replace("device ", "").replace(" detected", "").replace("doorbell ", "");
                console.log(`[WS Event] ${eventType} on ${device.getName()}`);
                handleMonitoringEvent(device, eventType);
            }
            break;
        }

        case "station livestream started": {
            console.log(`[WS Event] Livestream started for ${serialNumber}`);
            const device = deviceMap.get(currentStreamDevice);
            if (device && currentSocket) {
                // Get video codec from the message metadata
                const videoCodec = message.metadata?.videoCodec || 0; // 0 = H264, 1 = H265
                const ffmpeg = startFFmpeg(videoCodec, currentSocket);
                wsStreamProcesses.set(currentStreamDevice, ffmpeg);
                currentSocket.emit("stream-started");
            }
            break;
        }

        case "station livestream stopped": {
            console.log(`[WS Event] Livestream stopped for ${serialNumber}`);
            const ffmpeg = wsStreamProcesses.get(currentStreamDevice);
            if (ffmpeg) {
                ffmpeg.stdin?.end();
                ffmpeg.kill("SIGTERM");
                wsStreamProcesses.delete(currentStreamDevice);
            }
            if (currentSocket) {
                currentSocket.emit("stream-stopped");
            }
            break;
        }

        case "station livestream video data": {
            // Handle video data chunks from eufy-security-ws
            const deviceSerial = message.serialNumber || currentStreamDevice;
            const ffmpeg = wsStreamProcesses.get(deviceSerial);
            if (ffmpeg && ffmpeg.stdin && message.buffer) {
                try {
                    const videoData = Buffer.from(message.buffer.data || message.buffer);
                    ffmpeg.stdin.write(videoData);
                } catch (err) {
                    console.error("[WS] Error writing video data:", err.message);
                }
            }
            break;
        }

        default:
            // Log other events for debugging
            if (event && !event.includes("property changed")) {
                console.log(`[WS Event] ${event} - ${serialNumber}`);
            }
    }
}

// Start livestream via eufy-security-ws
async function startWsLivestream(deviceSerial) {
    const device = deviceMap.get(deviceSerial);
    if (!device) {
        throw new Error("Device not found");
    }

    console.log(`[WS] Starting livestream for ${device.getName()}...`);

    // Note: eufy-security-ws provides video via a different mechanism
    // We'll need to receive the stream data via the websocket
    const result = await sendWsCommand("device.start_livestream", {
        serialNumber: deviceSerial,
    });

    return result;
}

// Stop livestream via eufy-security-ws
async function stopWsLivestream(deviceSerial) {
    console.log(`[WS] Stopping livestream for ${deviceSerial}...`);

    const result = await sendWsCommand("device.stop_livestream", {
        serialNumber: deviceSerial,
    });

    return result;
}

// ==================== EVENT MONITORING ====================

async function analyzeEventImageWithUnusualFlag(image, cameraName, eventType) {
    const prompt = `You are monitoring security cameras. A "${eventType}" event was detected on "${cameraName}".

Analyze the image and respond in this exact JSON format:
{
  "description": "Brief description of what you see (1-2 sentences)",
  "isUnusual": true or false
}

Mark isUnusual as TRUE only if:
- Unknown person near doors/windows
- Suspicious activity (lurking, checking doors)
- Unexpected vehicles in driveway
- Someone at the door without a delivery
- Any potentially concerning activity

Mark isUnusual as FALSE for:
- Familiar faces (regular family members)
- Delivery personnel with packages
- Animals, wildlife
- Wind-triggered motion
- Normal daily activity`;

    const frames = [{ cameraName, frame: image }];

    try {
        let response = await queryAINonStreaming(prompt, frames);

        // Strip markdown code fences if present (```json ... ```)
        response = response.trim();
        if (response.startsWith("```")) {
            // Remove opening fence (```json or ```)
            response = response.replace(/^```(?:json)?\s*\n?/, "");
            // Remove closing fence
            response = response.replace(/\n?```\s*$/, "");
        }

        // Try to parse JSON response
        try {
            const parsed = JSON.parse(response);
            return {
                description: parsed.description || response,
                isUnusual: parsed.isUnusual === true,
            };
        } catch {
            // Fallback if AI doesn't return valid JSON
            // Try to extract description from malformed response
            const descMatch = response.match(/"description"\s*:\s*"([^"]+)"/);
            const unusualMatch = response.match(/"isUnusual"\s*:\s*(true|false)/i);

            if (descMatch) {
                return {
                    description: descMatch[1],
                    isUnusual: unusualMatch ? unusualMatch[1].toLowerCase() === "true" : false,
                };
            }

            // Last resort fallback
            return {
                description: response.substring(0, 200), // Truncate long responses
                isUnusual: response.toLowerCase().includes("unusual") ||
                           response.toLowerCase().includes("suspicious") ||
                           response.toLowerCase().includes("unknown person"),
            };
        }
    } catch (err) {
        console.error("[Monitor] AI analysis failed:", err);
        return {
            description: `Analysis failed: ${err.message}`,
            isUnusual: false,
        };
    }
}

async function appendToEventLog(entry) {
    const logPath = monitoringSettings.logFilePath;
    const unusualMarker = entry.isUnusual ? " [UNUSUAL]" : "";
    const logLine = `[${entry.timestamp}] ${entry.camera} | ${entry.eventType.toUpperCase()}${unusualMarker} | ${entry.aiAnalysis}\n`;

    try {
        // Ensure directory exists
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.appendFileSync(logPath, logLine);
        console.log(`[Monitor] Logged event to ${logPath}`);
    } catch (err) {
        console.error(`[Monitor] Failed to write log:`, err);
    }
}

async function handleMonitoringEvent(device, eventType, metadata) {
    if (!monitoringSettings.enabled) return;

    const timestamp = new Date().toISOString();
    const cameraName = device.getName();

    console.log(`[Monitor] ${eventType} detected on ${cameraName}`);

    // Get cached image (battery efficient)
    let image = null;
    try {
        const picture = device.getPropertyValue(PropertyName.DevicePicture);
        if (picture && picture.data) {
            image = Buffer.from(picture.data);
            console.log(`[Monitor] Got cached image for ${cameraName} (${image.length} bytes)`);
        }
    } catch (err) {
        console.log(`[Monitor] No cached image available for ${cameraName}:`, err.message);
    }

    // AI analysis
    let aiAnalysis = "No image available for analysis";
    let isUnusual = false;

    if (image) {
        const analysisResult = await analyzeEventImageWithUnusualFlag(image, cameraName, eventType);
        aiAnalysis = analysisResult.description;
        isUnusual = analysisResult.isUnusual;
    }

    // Create event entry
    const entry = {
        timestamp,
        camera: cameraName,
        eventType,
        aiAnalysis,
        isUnusual,
    };

    // Log to file
    await appendToEventLog(entry);

    // Emit to connected clients
    io.emit("monitoring-event", entry);

    // TTS announcement for unusual events
    if (isUnusual && ttsSettings.enabled) {
        const announcement = `Alert on ${cameraName}: ${aiAnalysis}`;
        await announceToHomeAssistant(announcement);
    }
}

function setupEventMonitoring() {
    console.log("[Monitor] Setting up event listeners for all devices...");

    for (const [serial, device] of deviceMap) {
        const deviceName = device.getName();

        // Motion events
        device.on("motion detected", (dev, state) => {
            if (state) {
                console.log(`[Monitor] Motion detected on ${deviceName}`);
                handleMonitoringEvent(dev, "motion");
            }
        });

        // Person detection
        device.on("person detected", (dev, state, person) => {
            if (state) {
                console.log(`[Monitor] Person detected on ${deviceName}`);
                handleMonitoringEvent(dev, "person", { person });
            }
        });

        // Vehicle detection
        device.on("vehicle detected", (dev, state) => {
            if (state) {
                console.log(`[Monitor] Vehicle detected on ${deviceName}`);
                handleMonitoringEvent(dev, "vehicle");
            }
        });

        // Pet detection
        device.on("pet detected", (dev, state) => {
            if (state) {
                console.log(`[Monitor] Pet detected on ${deviceName}`);
                handleMonitoringEvent(dev, "pet");
            }
        });

        // Sound detection
        device.on("sound detected", (dev, state) => {
            if (state) {
                console.log(`[Monitor] Sound detected on ${deviceName}`);
                handleMonitoringEvent(dev, "sound");
            }
        });

        // Doorbell rings
        device.on("rings", (dev, state) => {
            if (state) {
                console.log(`[Monitor] Doorbell ring on ${deviceName}`);
                handleMonitoringEvent(dev, "doorbell_ring");
            }
        });

        console.log(`[Monitor] Event listeners set up for ${deviceName}`);
    }
}

function startPeriodicMonitoring() {
    if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
    }

    if (!monitoringSettings.enabled || monitoringSettings.periodicInterval <= 0) {
        console.log("[Monitor] Periodic monitoring disabled");
        return;
    }

    const intervalMs = monitoringSettings.periodicInterval * 60 * 1000;

    periodicTimer = setInterval(async () => {
        console.log("[Monitor] Running periodic check...");

        for (const [serial, device] of deviceMap) {
            const raw = device.getRawDevice();
            if (!Device.isCamera(raw.device_type)) continue;

            await handleMonitoringEvent(device, "periodic_check");
        }
    }, intervalMs);

    console.log(`[Monitor] Periodic checks every ${monitoringSettings.periodicInterval} minutes`);
}

// ==================== FFMPEG HANDLERS ====================

function startFFmpeg(codec, socket) {
    const inputFormat = codec === 1 ? "hevc" : "h264"; // VideoCodec.H265 = 1
    console.log(`Starting ffmpeg with input format: ${inputFormat}`);

    jpegBuffer = Buffer.alloc(0);

    ffmpegProcess = spawn("ffmpeg", [
        "-f", inputFormat,
        "-i", "pipe:0",
        "-f", "mjpeg",
        "-q:v", "5",
        "-r", "10",
        "-vf", "scale=1024:-1",
        "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    ffmpegProcess.stdout?.on("data", (data) => {
        jpegBuffer = Buffer.concat([jpegBuffer, data]);

        while (true) {
            const startMarker = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
            if (startMarker === -1) {
                jpegBuffer = Buffer.alloc(0);
                break;
            }

            const endMarker = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD9]), startMarker + 2);
            if (endMarker === -1) {
                if (startMarker > 0) {
                    jpegBuffer = jpegBuffer.subarray(startMarker);
                }
                break;
            }

            const frame = jpegBuffer.subarray(startMarker, endMarker + 2);
            socket.emit("frame", frame.toString("base64"));
            jpegBuffer = jpegBuffer.subarray(endMarker + 2);
        }
    });

    ffmpegProcess.stderr?.on("data", (data) => {
        const msg = data.toString();
        if (!msg.includes("frame=") && !msg.includes("fps=") && !msg.includes("bitrate=")) {
            console.log("ffmpeg:", msg.trim());
        }
    });

    ffmpegProcess.on("close", (code) => {
        console.log(`ffmpeg exited with code ${code}`);
    });

    return ffmpegProcess;
}

function startDashboardFFmpeg(deviceSerial, codec, socket) {
    const inputFormat = codec === 1 ? "hevc" : "h264";
    console.log(`[Dashboard] Starting ffmpeg for ${deviceSerial} with format: ${inputFormat}`);

    const ffmpeg = spawn("ffmpeg", [
        "-f", inputFormat,
        "-i", "pipe:0",
        "-f", "mjpeg",
        "-q:v", "8",
        "-r", "5",
        "-vf", "scale=640:-1",
        "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let buffer = Buffer.alloc(0);

    ffmpeg.stdout?.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);

        while (true) {
            const startMarker = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
            if (startMarker === -1) {
                buffer = Buffer.alloc(0);
                break;
            }

            const endMarker = buffer.indexOf(Buffer.from([0xFF, 0xD9]), startMarker + 2);
            if (endMarker === -1) {
                if (startMarker > 0) {
                    buffer = buffer.subarray(startMarker);
                }
                break;
            }

            const frame = buffer.subarray(startMarker, endMarker + 2);
            socket.emit("dashboard-frame", { deviceSerial, frame: frame.toString("base64") });

            // Store latest frame for AI queries
            const streamState = dashboardStreams.get(deviceSerial);
            if (streamState) {
                streamState.latestFrame = Buffer.from(frame);
            }

            buffer = buffer.subarray(endMarker + 2);
        }

        const stream = dashboardStreams.get(deviceSerial);
        if (stream) {
            stream.jpegBuffer = buffer;
        }
    });

    ffmpeg.stderr?.on("data", (data) => {
        const msg = data.toString();
        if (!msg.includes("frame=") && !msg.includes("fps=")) {
            console.log(`[${deviceSerial}] ffmpeg:`, msg.trim());
        }
    });

    ffmpeg.on("close", (code) => {
        console.log(`[${deviceSerial}] ffmpeg exited with code ${code}`);
        dashboardStreams.delete(deviceSerial);
    });

    return ffmpeg;
}

function startAIQueryFFmpeg(deviceSerial, codec) {
    const inputFormat = codec === 1 ? "hevc" : "h264";
    console.log(`[AI] Starting ffmpeg for ${deviceSerial} with format: ${inputFormat}`);

    const ffmpeg = spawn("ffmpeg", [
        "-f", inputFormat,
        "-i", "pipe:0",
        "-f", "mjpeg",
        "-q:v", "5",
        "-frames:v", "3",
        "-vf", "scale=800:-1",
        "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let buffer = Buffer.alloc(0);
    let frameCaptured = false;

    ffmpeg.stdout?.on("data", (data) => {
        if (frameCaptured) return;

        buffer = Buffer.concat([buffer, data]);

        const startMarker = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
        if (startMarker === -1) return;

        const endMarker = buffer.indexOf(Buffer.from([0xFF, 0xD9]), startMarker + 2);
        if (endMarker === -1) return;

        const frame = buffer.subarray(startMarker, endMarker + 2);
        frameCaptured = true;

        console.log(`[AI] Captured frame from ${deviceSerial} (${frame.length} bytes)`);

        if (currentAIQuery) {
            currentAIQuery.capturedFrames.set(deviceSerial, Buffer.from(frame));
            currentAIQuery.pendingDevices.delete(deviceSerial);

            console.log(`[AI] Pending devices: ${currentAIQuery.pendingDevices.size}`);

            if (currentAIQuery.pendingDevices.size === 0) {
                processAIQuery();
            }
        }
    });

    ffmpeg.stderr?.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes("Error") || msg.includes("error")) {
            console.log(`[AI][${deviceSerial}] ffmpeg:`, msg.trim());
        }
    });

    ffmpeg.on("close", (code) => {
        console.log(`[AI][${deviceSerial}] ffmpeg exited with code ${code}`);
        aiQueryStreams.delete(deviceSerial);
    });

    return ffmpeg;
}

async function processAIQuery() {
    if (!currentAIQuery) return;

    const { query, socket, capturedFrames, startedStreams, timeoutId, startTime } = currentAIQuery;

    if (timeoutId) clearTimeout(timeoutId);

    console.log(`[AI] Processing query with ${capturedFrames.size} frames`);

    const frames = [];
    for (const [deviceSerial, frame] of capturedFrames) {
        const device = deviceMap.get(deviceSerial);
        const cameraName = device ? device.getName() : deviceSerial;
        frames.push({ cameraName, frame });
    }

    // Stop streams that we started
    for (const deviceSerial of startedStreams) {
        await stopAIQueryStream(deviceSerial);
    }

    currentAIQuery = null;

    if (frames.length === 0) {
        socket.emit("ai-error", "No camera frames could be captured");
        return;
    }

    try {
        socket.emit("ai-progress", `Analyzing ${frames.length} cameras with AI...`);
        await queryAIStreaming(query, frames, socket, startTime);
    } catch (error) {
        console.error("[AI] Error:", error);
        socket.emit("ai-error", error.message || "Failed to get AI response");
    }
}

async function stopAIQueryStream(deviceSerial) {
    const stream = aiQueryStreams.get(deviceSerial);
    if (stream) {
        stream.ffmpegProcess.stdin?.end();
        stream.ffmpegProcess.kill("SIGTERM");
        aiQueryStreams.delete(deviceSerial);
    }

    if (eufy) {
        try {
            const device = deviceMap.get(deviceSerial);
            if (device) {
                const stationSN = device.getRawDevice().station_sn;
                const station = await eufy.getStation(stationSN);
                if (station) {
                    try {
                        await station.stopLivestream(device);
                    } catch (e) {
                        // Ignore
                    }
                }
            }
        } catch (e) {
            // Ignore
        }
    }
}

async function stopStream() {
    if (ffmpegProcess) {
        ffmpegProcess.stdin?.end();
        ffmpegProcess.kill("SIGTERM");
        ffmpegProcess = null;
    }

    if (eufy && currentStreamDevice && !isDashboardMode) {
        try {
            const device = deviceMap.get(currentStreamDevice);
            if (device) {
                const stationSN = device.getRawDevice().station_sn;
                const station = await eufy.getStation(stationSN);
                if (station) {
                    try {
                        await station.stopLivestream(device);
                    } catch (e) {
                        // Ignore
                    }
                }
                // Clear the P2P session tracking
                activeP2PSessions.delete(stationSN);
            }
        } catch (e) {
            // Ignore
        }
    }
    currentStreamDevice = null;
}

async function stopAllDashboardStreams() {
    for (const [deviceSerial, stream] of dashboardStreams) {
        console.log(`[Dashboard] Stopping stream for ${deviceSerial}`);
        stream.ffmpegProcess.stdin?.end();
        stream.ffmpegProcess.kill("SIGTERM");

        if (eufy) {
            try {
                const device = deviceMap.get(deviceSerial);
                if (device) {
                    const stationSN = device.getRawDevice().station_sn;
                    const station = await eufy.getStation(stationSN);
                    if (station) {
                        try {
                            await station.stopLivestream(device);
                        } catch (e) {
                            // Ignore
                        }
                    }
                    // Clear P2P session tracking
                    activeP2PSessions.delete(stationSN);
                }
            } catch (e) {
                // Ignore
            }
        }
    }

    dashboardStreams.clear();
    isDashboardMode = false;
}

// ==================== EXPRESS ROUTES ====================

// Serve static files at root - HA ingress handles path rewriting
app.use("/", express.static(path.join(__dirname, "public")));

// API endpoint to get devices
app.get("/api/devices", async (req, res) => {
    // Check connection based on mode
    if (connectionMode === "ws") {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            return res.status(503).json({ error: "Not connected to eufy-security-ws" });
        }
    } else {
        if (!eufy) {
            return res.status(503).json({ error: "Not connected to Eufy" });
        }
    }

    const deviceList = Array.from(deviceMap.values()).map(device => {
        const raw = device.getRawDevice();
        const stationSN = raw.station_sn;
        const isStandalone = stationSN === device.getSerial() ||
                            stationSN.startsWith("T8416") ||
                            stationSN.startsWith("T85V0") ||
                            stationSN.startsWith("T8170") ||
                            stationSN.startsWith("T8131");
        return {
            serial: device.getSerial(),
            name: device.getName(),
            model: raw.device_model,
            type: raw.device_type,
            stationSN: stationSN,
            isDoorbell: Device.isDoorbell(raw.device_type),
            isCamera: Device.isCamera(raw.device_type),
            isStandalone: isStandalone,
        };
    });

    console.log(`API: Returning ${deviceList.length} devices`);
    res.json(deviceList);
});

// API endpoint to get monitoring settings
app.get("/api/monitoring", (req, res) => {
    res.json({
        enabled: monitoringSettings.enabled,
        periodicInterval: monitoringSettings.periodicInterval,
        ttsEnabled: ttsSettings.enabled,
        ttsMediaPlayer: ttsSettings.mediaPlayer,
    });
});

// API endpoint to get recent events
app.get("/api/events", (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const logPath = monitoringSettings.logFilePath;

    try {
        if (!fs.existsSync(logPath)) {
            return res.json([]);
        }

        const content = fs.readFileSync(logPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        const events = lines.slice(-limit).reverse().map(line => {
            const match = line.match(/\[(.*?)\] (.*?) \| (.*?) \| (.*)/);
            if (match) {
                return {
                    timestamp: match[1],
                    camera: match[2],
                    eventType: match[3],
                    aiAnalysis: match[4],
                    isUnusual: match[3].includes("[UNUSUAL]"),
                };
            }
            return { raw: line };
        });

        res.json(events);
    } catch (err) {
        console.error("Error reading events:", err);
        res.status(500).json({ error: "Failed to read events" });
    }
});

// API endpoint to get Home Assistant media players
app.get("/api/ha/media_players", async (req, res) => {
    if (!supervisorToken) {
        return res.json({ error: "Not running as Home Assistant addon", entities: [] });
    }

    try {
        const response = await fetch(`${haApiUrl}/states`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${supervisorToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            console.error(`[HA API] Failed to fetch states: ${response.status}`);
            return res.json({ error: `Failed to fetch from HA: ${response.status}`, entities: [] });
        }

        const states = await response.json();
        const mediaPlayers = states
            .filter(entity => entity.entity_id.startsWith("media_player."))
            .map(entity => ({
                entity_id: entity.entity_id,
                friendly_name: entity.attributes.friendly_name || entity.entity_id,
                state: entity.state,
            }))
            .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));

        console.log(`[HA API] Found ${mediaPlayers.length} media players`);
        res.json({ entities: mediaPlayers });
    } catch (err) {
        console.error("[HA API] Error fetching media players:", err);
        res.json({ error: err.message, entities: [] });
    }
});

// ==================== SOCKET.IO ====================

io.on("connection", (socket) => {
    console.log("Client connected");
    currentSocket = socket;

    // AI Settings handlers
    socket.on("get-ai-settings", () => {
        const safeSettings = {
            ...aiSettings,
            openaiApiKey: aiSettings.openaiApiKey ? "****" + aiSettings.openaiApiKey.slice(-4) : "",
            geminiApiKey: aiSettings.geminiApiKey ? "****" + aiSettings.geminiApiKey.slice(-4) : "",
        };
        socket.emit("ai-settings", safeSettings);
    });

    socket.on("update-ai-settings", (newSettings) => {
        console.log("[AI] Updating settings");

        if (newSettings.provider) aiSettings.provider = newSettings.provider;
        if (newSettings.ollamaUrl) aiSettings.ollamaUrl = newSettings.ollamaUrl;
        if (newSettings.ollamaModel) aiSettings.ollamaModel = newSettings.ollamaModel;
        if (newSettings.openaiApiKey && !newSettings.openaiApiKey.startsWith("****")) {
            aiSettings.openaiApiKey = newSettings.openaiApiKey;
        }
        if (newSettings.openaiModel) aiSettings.openaiModel = newSettings.openaiModel;
        if (newSettings.geminiApiKey && !newSettings.geminiApiKey.startsWith("****")) {
            aiSettings.geminiApiKey = newSettings.geminiApiKey;
        }
        if (newSettings.geminiModel) aiSettings.geminiModel = newSettings.geminiModel;

        socket.emit("ai-settings-updated", { success: true });
    });

    // Monitoring settings
    socket.on("get-monitoring-settings", () => {
        socket.emit("monitoring-settings", {
            enabled: monitoringSettings.enabled,
            periodicInterval: monitoringSettings.periodicInterval,
            ttsEnabled: ttsSettings.enabled,
            ttsMediaPlayer: ttsSettings.mediaPlayer,
        });
    });

    socket.on("update-monitoring-settings", (newSettings) => {
        console.log("[Monitor] Updating settings:", newSettings);

        if (typeof newSettings.enabled === "boolean") {
            monitoringSettings.enabled = newSettings.enabled;
        }
        if (typeof newSettings.periodicInterval === "number") {
            monitoringSettings.periodicInterval = newSettings.periodicInterval;
        }
        if (typeof newSettings.ttsEnabled === "boolean") {
            ttsSettings.enabled = newSettings.ttsEnabled;
        }
        if (newSettings.ttsMediaPlayer !== undefined) {
            ttsSettings.mediaPlayer = newSettings.ttsMediaPlayer;
        }

        // Restart periodic monitoring with new settings
        startPeriodicMonitoring();

        socket.emit("monitoring-settings-updated", { success: true });
    });

    // Single stream handlers
    socket.on("start-stream", async (deviceSerial) => {
        console.log(`\n${"=".repeat(40)}`);
        console.log(`Starting stream for device: ${deviceSerial}`);
        isDashboardMode = false;

        // Handle WS mode
        if (connectionMode === "ws") {
            if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
                socket.emit("error", "Not connected to eufy-security-ws");
                return;
            }

            try {
                const device = deviceMap.get(deviceSerial);
                if (!device) {
                    socket.emit("error", `Device not found: ${deviceSerial}`);
                    return;
                }

                currentStreamDevice = deviceSerial;
                console.log(`[WS] Starting stream for ${device.getName()}...`);
                await startWsLivestream(deviceSerial);
            } catch (error) {
                console.error("Error starting WS stream:", error);
                socket.emit("error", error.message || "Failed to start stream");
            }
            return;
        }

        // Direct mode
        if (!eufy) {
            socket.emit("error", "Not connected to Eufy");
            return;
        }

        try {
            const device = deviceMap.get(deviceSerial);
            if (!device) {
                socket.emit("error", `Device not found: ${deviceSerial}`);
                return;
            }

            const stationSN = device.getRawDevice().station_sn;
            const station = await eufy.getStation(stationSN);
            if (!station) {
                socket.emit("error", "Station not found");
                return;
            }

            // Check for P2P conflict - only one stream at a time per HomeBase
            const activeSession = activeP2PSessions.get(stationSN);
            if (activeSession && activeSession.deviceSerial !== deviceSerial) {
                const activeDevice = deviceMap.get(activeSession.deviceSerial);
                const activeName = activeDevice ? activeDevice.getName() : activeSession.deviceSerial;
                console.log(`[Stream] P2P conflict detected: ${activeName} is currently streaming on this HomeBase`);

                // Stop the existing stream first
                console.log(`[Stream] Auto-stopping existing stream for ${activeName}...`);
                socket.emit("stream-info", `Stopping ${activeName} to start ${device.getName()}...`);

                try {
                    await station.stopLivestream(activeDevice || device);
                    activeP2PSessions.delete(stationSN);
                    // Wait for the stop to complete
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (stopErr) {
                    console.log(`[Stream] Error stopping existing stream: ${stopErr.message}`);
                }
            }

            // Track this session
            activeP2PSessions.set(stationSN, {
                deviceSerial,
                type: "single",
                startTime: Date.now(),
            });

            currentStreamDevice = deviceSerial;
            console.log(`[Stream] Starting stream for ${device.getName()}...`);
            await station.startLivestream(device);
        } catch (error) {
            console.error("Error starting stream:", error);
            const errorMsg = error.message || "Failed to start stream";

            // Provide more helpful error messages
            if (errorMsg.includes("P2P") || errorMsg.includes("connection")) {
                socket.emit("error", "P2P connection failed. The HomeBase may be busy or unreachable. Try again in a few seconds.");
            } else if (errorMsg.includes("timeout")) {
                socket.emit("error", "Stream request timed out. The camera may be offline or out of range.");
            } else {
                socket.emit("error", errorMsg);
            }
        }
    });

    socket.on("stop-stream", async () => {
        console.log("Stop stream requested");

        // Handle WS mode
        if (connectionMode === "ws") {
            if (currentStreamDevice) {
                try {
                    await stopWsLivestream(currentStreamDevice);
                } catch (err) {
                    console.error("[WS] Error stopping stream:", err.message);
                }

                const ffmpeg = wsStreamProcesses.get(currentStreamDevice);
                if (ffmpeg) {
                    ffmpeg.stdin?.end();
                    ffmpeg.kill("SIGTERM");
                    wsStreamProcesses.delete(currentStreamDevice);
                }
                currentStreamDevice = null;
            }
            socket.emit("stream-stopped");
            return;
        }

        await stopStream();
        socket.emit("stream-stopped");
    });

    // Dashboard stream handlers
    socket.on("start-all-streams", async (deviceSerials) => {
        console.log(`\n${"=".repeat(40)}`);
        console.log(`Starting dashboard streams for ${deviceSerials.length} devices`);
        isDashboardMode = true;

        await stopStream();

        if (!eufy) {
            socket.emit("error", "Not connected to Eufy");
            return;
        }

        for (const deviceSerial of deviceSerials) {
            socket.emit("dashboard-stream-connecting", deviceSerial);

            try {
                const device = deviceMap.get(deviceSerial);
                if (!device) {
                    socket.emit("dashboard-stream-error", { deviceSerial, error: "Device not found" });
                    continue;
                }

                const stationSN = device.getRawDevice().station_sn;
                const station = await eufy.getStation(stationSN);
                if (!station) {
                    socket.emit("dashboard-stream-error", { deviceSerial, error: "Station not found" });
                    continue;
                }

                await station.startLivestream(device);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`[Dashboard] Error starting stream for ${deviceSerial}:`, error);
                socket.emit("dashboard-stream-error", { deviceSerial, error: error.message });
            }
        }
    });

    socket.on("stop-all-streams", async () => {
        console.log("Stop all dashboard streams requested");
        await stopAllDashboardStreams();
    });

    // HomeBase camera stream control
    socket.on("start-homebase-stream", async (deviceSerial) => {
        console.log(`[HomeBase] Starting stream for: ${deviceSerial}`);

        if (!eufy) {
            socket.emit("dashboard-stream-error", { deviceSerial, error: "Not connected to Eufy" });
            return;
        }

        try {
            const device = deviceMap.get(deviceSerial);
            if (!device) {
                socket.emit("dashboard-stream-error", { deviceSerial, error: "Device not found" });
                return;
            }

            const stationSN = device.getRawDevice().station_sn;
            const station = await eufy.getStation(stationSN);
            if (!station) {
                socket.emit("dashboard-stream-error", { deviceSerial, error: "Station not found" });
                return;
            }

            await station.startLivestream(device);
        } catch (error) {
            console.error(`[HomeBase] Error starting stream for ${deviceSerial}:`, error);
            socket.emit("dashboard-stream-error", { deviceSerial, error: error.message });
        }
    });

    socket.on("stop-homebase-stream", async (deviceSerial) => {
        console.log(`[HomeBase] Stopping stream for: ${deviceSerial}`);

        const stream = dashboardStreams.get(deviceSerial);
        if (stream) {
            stream.ffmpegProcess.stdin?.end();
            stream.ffmpegProcess.kill("SIGTERM");
            dashboardStreams.delete(deviceSerial);
        }

        if (eufy) {
            try {
                const device = deviceMap.get(deviceSerial);
                if (device) {
                    const stationSN = device.getRawDevice().station_sn;
                    const station = await eufy.getStation(stationSN);
                    if (station) {
                        try {
                            await station.stopLivestream(device);
                        } catch (e) {
                            // Ignore
                        }
                    }
                }
            } catch (e) {
                // Ignore
            }
        }
    });

    // AI Query handler
    socket.on("ai-query", async (query) => {
        const queryStartTime = Date.now();
        console.log(`\n${"=".repeat(40)}`);
        console.log(`[AI] Received query: ${query}`);
        console.log(`[AI] Using provider: ${aiSettings.provider}`);

        if (!eufy) {
            socket.emit("ai-error", "Not connected to Eufy");
            return;
        }

        if (currentAIQuery) {
            if (currentAIQuery.timeoutId) clearTimeout(currentAIQuery.timeoutId);
            currentAIQuery = null;
        }

        try {
            const streamableDevices = [];
            for (const [serial, device] of deviceMap) {
                const raw = device.getRawDevice();
                if (Device.isDoorbell(raw.device_type) || Device.isCamera(raw.device_type)) {
                    streamableDevices.push(device);
                }
            }

            if (streamableDevices.length === 0) {
                socket.emit("ai-error", "No cameras found");
                return;
            }

            const cameraNames = streamableDevices.map(d => d.getName()).join(", ");
            socket.emit("ai-progress", `Found ${streamableDevices.length} cameras: ${cameraNames}`);

            // Check for existing frames from dashboard streams
            const existingFrames = [];
            const devicesNeedingStreams = [];

            for (const device of streamableDevices) {
                const serial = device.getSerial();
                const dashboardStream = dashboardStreams.get(serial);

                if (dashboardStream?.latestFrame) {
                    existingFrames.push({
                        cameraName: device.getName(),
                        frame: dashboardStream.latestFrame,
                    });
                    socket.emit("ai-progress", `✓ Using cached frame from ${device.getName()}`);
                } else {
                    devicesNeedingStreams.push(device);
                }
            }

            if (devicesNeedingStreams.length === 0) {
                socket.emit("ai-progress", `Analyzing ${existingFrames.length} cameras with AI...`);
                await queryAIStreaming(query, existingFrames, socket, queryStartTime);
                return;
            }

            socket.emit("ai-progress", `Starting ${devicesNeedingStreams.length} camera streams...`);

            const capturedFrames = new Map();
            existingFrames.forEach(f => {
                const device = streamableDevices.find(d => d.getName() === f.cameraName);
                if (device) capturedFrames.set(device.getSerial(), f.frame);
            });

            currentAIQuery = {
                query,
                socket,
                pendingDevices: new Set(devicesNeedingStreams.map(d => d.getSerial())),
                capturedFrames,
                startedStreams: new Set(devicesNeedingStreams.map(d => d.getSerial())),
                startTime: queryStartTime,
            };

            const CAPTURE_TIMEOUT = 15000;

            const streamPromises = devicesNeedingStreams.map(async (device) => {
                const deviceSerial = device.getSerial();
                const stationSN = device.getRawDevice().station_sn;

                try {
                    const station = await eufy.getStation(stationSN);
                    if (!station) {
                        return null;
                    }

                    socket.emit("ai-progress", `⏳ Connecting to ${device.getName()}...`);

                    const framePromise = new Promise((resolve) => {
                        const checkFrame = setInterval(() => {
                            if (currentAIQuery?.capturedFrames.has(deviceSerial)) {
                                clearInterval(checkFrame);
                                resolve({
                                    cameraName: device.getName(),
                                    frame: currentAIQuery.capturedFrames.get(deviceSerial),
                                });
                            }
                        }, 100);

                        setTimeout(() => {
                            clearInterval(checkFrame);
                            resolve(null);
                        }, CAPTURE_TIMEOUT);
                    });

                    try {
                        station.startLivestream(device);
                    } catch (err) {
                        console.log(`[AI] Stream start failed for ${device.getName()}: ${err.message}`);
                    }

                    const result = await Promise.race([
                        framePromise,
                        new Promise((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT))
                    ]);

                    if (result) {
                        socket.emit("ai-progress", `✓ Captured frame from ${device.getName()}`);
                    } else {
                        socket.emit("ai-progress", `✗ Timeout: ${device.getName()} (skipped)`);
                    }

                    return result;
                } catch (error) {
                    socket.emit("ai-progress", `✗ Error: ${device.getName()}`);
                    return null;
                }
            });

            const results = await Promise.all(streamPromises);
            const allFrames = [
                ...existingFrames,
                ...results.filter(r => r !== null)
            ];

            socket.emit("ai-progress", `Captured ${allFrames.length}/${streamableDevices.length} cameras`);

            socket.emit("ai-progress", `Stopping camera streams...`);
            for (const device of devicesNeedingStreams) {
                await stopAIQueryStream(device.getSerial());
            }
            currentAIQuery = null;

            if (allFrames.length === 0) {
                socket.emit("ai-error", "No camera frames could be captured");
                return;
            }

            socket.emit("ai-progress", `🤖 Sending ${allFrames.length} images to AI...`);
            await queryAIStreaming(query, allFrames, socket, queryStartTime);
        } catch (error) {
            console.error("[AI] Error processing query:", error);
            socket.emit("ai-error", error.message || "Failed to process AI query");
            currentAIQuery = null;
        }
    });

    socket.on("disconnect", async () => {
        console.log("Client disconnected");
        currentSocket = null;
        await stopStream();
        await stopAllDashboardStreams();
    });
});

// ==================== EUFY INITIALIZATION ====================

async function initializeEufy() {
    if (!config.username || !config.password) {
        console.error("ERROR: Eufy username and password are required!");
        console.error("Please configure them in the Home Assistant addon settings.");
        return;
    }

    // Ensure persistent directory exists
    if (!fs.existsSync(persistentDir)) {
        fs.mkdirSync(persistentDir, { recursive: true });
        console.log(`Created persistent directory: ${persistentDir}`);
    }

    console.log("Initializing Eufy client...");
    console.log(`Username: ${config.username}`);
    console.log(`Country: ${config.country}`);
    console.log(`Persistent Dir: ${persistentDir}`);

    try {
        eufy = await EufySecurity.initialize(config);
    } catch (err) {
        console.error("ERROR initializing Eufy client:", err);
        return;
    }

    // Error handlers
    eufy.on("connection error", (error) => {
        console.error("[Eufy] Connection error:", error);
    });

    eufy.on("tfa request", () => {
        console.warn("[Eufy] 2FA REQUIRED - Please check your email/SMS for verification code");
        console.warn("[Eufy] You may need to use a separate Eufy account without 2FA, or authenticate via the official eufy-security-ws addon first");
    });

    eufy.on("captcha request", (id, captcha) => {
        console.warn("[Eufy] CAPTCHA REQUIRED - Eufy is requesting captcha verification");
        console.warn("[Eufy] Try again later or use eufy-security-ws addon to handle captcha");
    });

    eufy.on("connect", () => {
        console.log("[Eufy] Connected to Eufy cloud successfully!");
    });

    eufy.on("close", () => {
        console.log("[Eufy] Connection closed");
    });

    eufy.on("push connect", () => {
        console.log("[Eufy] Push notification service connected");
    });

    eufy.on("push close", () => {
        console.log("[Eufy] Push notification service disconnected");
    });

    // Station events
    eufy.on("station added", (station) => {
        console.log(`[Eufy] Station added: ${station.getName()} (${station.getSerial()})`);
    });

    eufy.on("device added", (device) => {
        const raw = device.getRawDevice();
        console.log(`[Eufy] Device added: ${device.getName()} (${raw.device_model}) - Type: ${raw.device_type}`);
        deviceMap.set(device.getSerial(), device);
    });

    eufy.on("device removed", (device) => {
        console.log(`[Eufy] Device removed: ${device.getName()}`);
        deviceMap.delete(device.getSerial());
    });

    eufy.on("station livestream start", (station, device, metadata, videoStream, audioStream) => {
        const deviceSerial = device.getSerial();
        console.log(`\n*** LIVESTREAM STARTED ***`);
        console.log(`Device: ${device.getName()} (${deviceSerial})`);
        console.log(`Video codec: ${metadata.videoCodec}`);

        // Check if this stream was started for an AI query
        if (currentAIQuery && currentAIQuery.startedStreams.has(deviceSerial)) {
            const ffmpeg = startAIQueryFFmpeg(deviceSerial, metadata.videoCodec);

            aiQueryStreams.set(deviceSerial, {
                ffmpegProcess: ffmpeg,
                jpegBuffer: Buffer.alloc(0),
                deviceSerial,
                latestFrame: null,
            });

            if (ffmpeg.stdin) {
                videoStream.pipe(ffmpeg.stdin);
            }
            return;
        }

        if (currentSocket) {
            if (isDashboardMode) {
                const ffmpeg = startDashboardFFmpeg(deviceSerial, metadata.videoCodec, currentSocket);

                dashboardStreams.set(deviceSerial, {
                    ffmpegProcess: ffmpeg,
                    jpegBuffer: Buffer.alloc(0),
                    deviceSerial,
                    latestFrame: null,
                });

                if (ffmpeg.stdin) {
                    videoStream.pipe(ffmpeg.stdin);
                }

                currentSocket.emit("dashboard-stream-started", deviceSerial);
            } else {
                const ffmpeg = startFFmpeg(metadata.videoCodec, currentSocket);

                if (ffmpeg.stdin) {
                    videoStream.pipe(ffmpeg.stdin);
                }

                currentSocket.emit("stream-started");
            }
        }
    });

    eufy.on("station livestream stop", (station, device) => {
        const deviceSerial = device.getSerial();
        console.log(`Livestream stopped for ${device.getName()}`);

        if (currentSocket) {
            if (isDashboardMode) {
                const stream = dashboardStreams.get(deviceSerial);
                if (stream) {
                    stream.ffmpegProcess.stdin?.end();
                    stream.ffmpegProcess.kill("SIGTERM");
                    dashboardStreams.delete(deviceSerial);
                }
            } else {
                currentSocket.emit("stream-stopped");
            }
        }
    });

    eufy.on("station connect", (station) => {
        console.log(`Station connected: ${station.getName()}`);
    });

    eufy.on("station close", (station) => {
        console.log(`Station closed: ${station.getName()}`);
    });

    console.log("Connecting to Eufy cloud...");
    try {
        await eufy.connect();
        console.log("[Eufy] connect() completed");
    } catch (err) {
        console.error("[Eufy] Error during connect():", err);
        return;
    }

    // Wait a bit for initial device discovery
    console.log("Waiting for initial device discovery (5s)...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Try to explicitly refresh data
    if (deviceMap.size === 0) {
        console.log("[Eufy] No devices found yet, trying refreshCloudData...");
        try {
            await eufy.refreshCloudData();
            console.log("[Eufy] refreshCloudData() completed");
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (err) {
            console.log("[Eufy] refreshCloudData error:", err.message);
        }
    }

    // Check if we got devices now
    if (deviceMap.size === 0) {
        console.log("[Eufy] Still no devices. Checking connection status...");
        console.log(`[Eufy] isConnected: ${eufy.isConnected()}`);

        // Try getting devices directly from the client
        try {
            const devices = eufy.getDevices();
            console.log(`[Eufy] getDevices() returned ${devices.length} devices`);
            for (const device of devices) {
                const raw = device.getRawDevice();
                console.log(`[Eufy] Found device: ${device.getName()} (${raw.device_model})`);
                deviceMap.set(device.getSerial(), device);
            }
        } catch (err) {
            console.log("[Eufy] getDevices() error:", err.message);
        }

        // Try getting stations
        try {
            const stations = eufy.getStations();
            console.log(`[Eufy] getStations() returned ${stations.length} stations`);
            for (const station of stations) {
                console.log(`[Eufy] Station: ${station.getName()} (${station.getSerial()})`);
            }
        } catch (err) {
            console.log("[Eufy] getStations() error:", err.message);
        }
    }

    console.log(`\nEufy client ready! Found ${deviceMap.size} devices:`);
    deviceMap.forEach((device, serial) => {
        const raw = device.getRawDevice();
        const type = Device.isDoorbell(raw.device_type) ? "Doorbell" :
                     Device.isCamera(raw.device_type) ? "Camera" : "Other";
        console.log(`  - ${device.getName()} (${raw.device_model}) [${type}]`);
    });

    if (deviceMap.size === 0) {
        console.warn("\n[WARNING] No devices found! Possible causes:");
        console.warn("  1. 2FA is required - check logs above for 'tfa request'");
        console.warn("  2. Captcha required - check logs above for 'captcha request'");
        console.warn("  3. Wrong credentials - verify username/password in addon settings");
        console.warn("  4. Account issue - try logging into the Eufy app first");
        console.warn("  5. First-time auth - delete /config/eufy-monitor and restart");
    }

    // Setup event monitoring
    setupEventMonitoring();
    startPeriodicMonitoring();

    console.log("");
}

// ==================== START SERVER ====================

httpServer.listen(PORT, async () => {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Eufy Security Monitor - Home Assistant Addon`);
    console.log(`${"=".repeat(50)}`);
    console.log(`Server running on port ${PORT}`);
    console.log(`Connection mode: ${connectionMode}`);
    console.log(`Ingress path: ${ingressPath || "(none)"}`);
    console.log(`Monitoring enabled: ${monitoringSettings.enabled}`);
    console.log(`TTS enabled: ${ttsSettings.enabled}`);
    console.log(`${"=".repeat(50)}\n`);

    // Initialize based on connection mode
    if (connectionMode === "ws") {
        try {
            await initializeEufyWs();
            console.log(`\nConnected via eufy-security-ws! Found ${deviceMap.size} devices.`);

            // Setup monitoring for WS mode
            startPeriodicMonitoring();
        } catch (err) {
            console.error("Failed to connect to eufy-security-ws:", err.message);
            console.error("Make sure the eufy-security-ws addon is running and accessible.");
        }
    } else {
        await initializeEufy();
    }
});

process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    if (periodicTimer) clearInterval(periodicTimer);
    await stopStream();
    await stopAllDashboardStreams();
    if (wsClient) {
        wsClient.close();
    }
    if (eufy) {
        await eufy.close();
    }
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("\nReceived SIGTERM, shutting down...");
    if (periodicTimer) clearInterval(periodicTimer);
    await stopStream();
    await stopAllDashboardStreams();
    if (eufy) {
        await eufy.close();
    }
    process.exit(0);
});
