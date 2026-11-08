# ---------- Stage 1: builder ----------
FROM node:22-slim AS builder

WORKDIR /app

# Toolchain in case a native addon (classic-level / sharp) lacks a prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install production dependencies against the committed lockfile (tsx included).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application sources (node_modules is excluded via .dockerignore).
COPY . .

# ---------- Stage 2: runtime ----------
FROM node:22-slim

WORKDIR /app

# Fonts for SVG → PNG graph text (sharp); conntrack + iproute2 power the
# DDoS detector's connection/SYN inspection (optional, degrades gracefully).
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core conntrack iproute2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENV NODE_ENV=production
ENV FONTCONFIG_PATH=/etc/fonts

# tsx runs the TypeScript entrypoint directly, no separate build step.
CMD ["node", "node_modules/.bin/tsx", "index.ts"]
