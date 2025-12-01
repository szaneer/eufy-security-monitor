ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    ffmpeg \
    python3 \
    make \
    g++

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY app/package*.json ./

# Install dependencies
RUN npm install && npm cache clean --force

# Copy application files
COPY app/ ./

# Copy run script to s6-overlay service directory
COPY run.sh /etc/services.d/eufy-monitor/run
COPY finish.sh /etc/services.d/eufy-monitor/finish
RUN chmod a+x /etc/services.d/eufy-monitor/run /etc/services.d/eufy-monitor/finish
