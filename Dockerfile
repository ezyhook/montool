# ---------- Stage 1: builder ----------
FROM node:22-slim AS builder

WORKDIR /app

# Toolchain in case a native addon (classic-level / sharp) lacks a prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install all deps (incl. esbuild). `npm install` (not `npm ci`) so sharp's
# platform-specific prebuilt binary resolves for the image's os/arch/libc.
COPY package.json package-lock.json ./
RUN npm install

# Build the single-file bundle, then drop dev dependencies for a lean runtime.
COPY . .
RUN npm run build \
 && [ -f dist/index.js ] \
 && npm prune --omit=dev

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

# Run the precompiled bundle: fastest startup, lowest memory.
CMD ["node", "dist/index.js"]
