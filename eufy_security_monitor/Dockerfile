ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    ffmpeg \
    python3 \
    make \
    g++ \
    jq \
    bash

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY app/package*.json ./

# Install dependencies
RUN npm install && npm cache clean --force

# Copy application files
COPY app/ ./

# Copy s6-overlay service files
COPY rootfs /

# Ensure s6-overlay runs as PID 1 (exec form required)
ENTRYPOINT ["/init"]
