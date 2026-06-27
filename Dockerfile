# PDFFleet PDF API — headless Chromium render in a minimal container
# Base: official Playwright image (has patched Chromium + all OS deps baked in)
FROM node:20-bookworm-slim

# Install Chromium runtime deps + fonts for consistent PDF rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    fonts-noto-core \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install app deps first (cache layer)
COPY package.json ./
# install Chromium into a shared, world-readable path so the non-root user can launch it
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --omit=dev && npx playwright install chromium && chmod -R a+rX /ms-playwright

# Copy app code
COPY server.js ./
COPY site/ ./site/
COPY templates/ ./data/templates/

# Persistent data volume (API keys, templates); run as the unprivileged node user (uid 1000)
RUN mkdir -p /data/templates && chown -R node:node /app /data
USER node
VOLUME ["/data"]

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
