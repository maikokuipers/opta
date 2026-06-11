FROM node:22-slim

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright Chromium + all its OS dependencies automatically
RUN npx playwright install --with-deps chromium

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
