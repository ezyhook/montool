# ---------- Stage 1: builder ----------
# Use a Bun that understands the text bun.lock (1.2+); the `1` tag floats to
# the latest 1.x release.
FROM oven/bun:1 AS builder

WORKDIR /app

# Toolchain for building native addons (classic-level, via node-gyp-build).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies against the committed lockfile first (better caching).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Application sources (node_modules is excluded via .dockerignore).
COPY . .

# ---------- Stage 2: runtime ----------
FROM oven/bun:1

WORKDIR /app

# Fonts for SVG → PNG graph text (sharp); conntrack + iproute2 power the
# DDoS detector's connection/SYN inspection (optional, degrades gracefully).
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core conntrack iproute2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

RUN chown -R bun:bun /app
USER bun

ENV NODE_ENV=production
ENV FONTCONFIG_PATH=/etc/fonts

# Bun runs the TypeScript entrypoint directly (types are stripped at load).
CMD ["bun", "index.ts"]
