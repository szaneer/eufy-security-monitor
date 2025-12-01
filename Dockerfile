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

# Make run script executable
RUN chmod +x /app/run.sh

# Run the application directly (bypass s6-overlay)
CMD ["/app/run.sh"]
