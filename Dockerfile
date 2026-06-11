FROM node:22-slim

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2t64 \
    libxshmfence1 \
    libx11-xcb1 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]
