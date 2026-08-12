# --- STAGE 1: NODE BUILDER ---
FROM node:22-bookworm AS builder
WORKDIR /app

# Tool di base
RUN apt-get update && apt-get install -y build-essential git python3 && rm -rf /var/lib/apt/lists/*

# Il progetto usa npm: `package-lock.json` è il lockfile mantenuto, e `.npmrc`
# serve prima di `npm ci` perché senza `legacy-peer-deps` il conflitto di peer
# fra @nestjs/platform-fastify e @nestjs/swagger su @fastify/static blocca
# l'installazione.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run build

# --- STAGE 2: PRODUCTION RUNNER (BOOKWORM = FFmpeg 5.1+) ---
FROM node:22-bookworm-slim
WORKDIR /app

# Installiamo dipendenze runtime
# - ffmpeg: audio processing (BOOKWORM = v5.1+ con supporto normalize)
# - curl: used to download Litestream in the layer below
# - procps: process monitoring (htop/top)
# - libgomp1: OpenMP, required by the native dependencies
# - ca-certificates: REQUIRED for HTTPS (Discord, Oracle, AI providers)
#
# python3 and yt-dlp used to be here for the YouTube branch of
# `$debug teststream`, now removed: it was arbitrary command execution plus a
# YouTube downloader shipped alongside the bot.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    procps \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installiamo Litestream (ARM64)
RUN curl -L https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-arm64.tar.gz -o /tmp/litestream.tar.gz && \
    tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && \
    rm /tmp/litestream.tar.gz

ENV NODE_ENV=production

# Copia App Node & Config
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY litestream.yml /etc/litestream.yml

# La trascrizione avviene fuori da questo container (PC remoto del tavolo o
# provider cloud con la chiave dell'utente): nessun binario Whisper a bordo.
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Cartelle dati
RUN mkdir -p recordings batch_processing data mixed_sessions

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
