# --- STAGE 1: NODE BUILDER ---
FROM node:22-bookworm AS builder
WORKDIR /app

# Tool di base
RUN apt-get update && apt-get install -y build-essential git python3 && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

# --- STAGE 2: WHISPER (usa immagine pre-buildata) ---
# L'immagine whisper-large-v3 viene buildata UNA SOLA VOLTA con:
#   docker build -f Dockerfile.whisper -t whisper-large-v3 .
# Sopravvive a docker system prune (è un'immagine taggata, non cache)
FROM whisper-large-v3:latest AS whisper-builder

# --- STAGE 3: PRODUCTION RUNNER (BOOKWORM = FFmpeg 5.1+) ---
FROM node:22-bookworm-slim
WORKDIR /app

# Installiamo dipendenze runtime
# - ffmpeg: audio processing (BOOKWORM = v5.1+ con supporto normalize)
# - python3: runtime per yt-dlp
# - curl: download tool
# - procps: monitoraggio processi (htop/top)
# - libgomp1: NECESSARIO per OpenMP (whisper.cpp crasha senza questo)
# - ca-certificates: NECESSARIO per HTTPS (Discord, YouTube, Oracle)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    procps \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installiamo yt-dlp standalone
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Installiamo Litestream (ARM64)
RUN curl -L https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-arm64.tar.gz -o /tmp/litestream.tar.gz && \
    tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && \
    rm /tmp/litestream.tar.gz

ENV NODE_ENV=production

# Copia App Node & Config
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY litestream.yml /etc/litestream.yml

# === WHISPER PERSISTENCE ===
# Whisper viene salvato in due posti:
# 1. /app/whisper-backup (interno all'immagine, sempre disponibile)
# 2. /app/whisper (volume, persiste dopo docker system prune)
# L'entrypoint copia dal backup al volume se necessario.

# Backup interno (sopravvive ai rebuild dell'immagine)
RUN mkdir -p /app/whisper-backup
COPY --from=whisper-builder /whisper/build/bin/whisper-cli /app/whisper-backup/main
COPY --from=whisper-builder /whisper/models/ggml-large-v3.bin /app/whisper-backup/model.bin
COPY --from=whisper-builder /whisper/models/ggml-distil-it-q5_0.bin /app/whisper-backup/model-distil-it.bin
RUN chmod +x /app/whisper-backup/main

# Directory per il volume (sarà popolata dall'entrypoint)
RUN mkdir -p /app/whisper

# Entrypoint per gestire la persistenza
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Cartelle dati
RUN mkdir -p recordings batch_processing data mixed_sessions

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
