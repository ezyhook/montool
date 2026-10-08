# ---------- Stage 1: builder ----------
FROM oven/bun:1.1.13 AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

COPY . .


# ---------- Stage 2: runtime ----------
FROM oven/bun:1.1.13

WORKDIR /app

COPY --from=builder /app /app

RUN chown -R bun:bun /app
USER bun

ENV NODE_ENV=production

CMD ["bun", "index.ts"]