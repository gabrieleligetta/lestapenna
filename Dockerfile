# --- STAGE 1: NODE BUILDER ---
FROM node:22-bookworm AS builder
WORKDIR /app

# Tool di base
RUN apt-get update && apt-get install -y build-essential git python3 && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

# --- STAGE 2: WHISPER COMPILER (BULLSEYE = GCC 10, NO FP16 BUG) ---
FROM debian:bullseye-slim AS whisper-builder

# AGGIUNTO 'cmake': Richiesto per la compilazione delle nuove versioni di whisper.cpp
RUN apt-get update && apt-get install -y build-essential git make curl cmake && rm -rf /var/lib/apt/lists/*

# Clona whisper.cpp (cached)
RUN --mount=type=cache,target=/cache/whisper \
    if [ -d /cache/whisper/.git ]; then \
        cp -r /cache/whisper /build; \
    else \
        git clone https://github.com/ggerganov/whisper.cpp.git /build && \
        cp -r /build /cache/whisper; \
    fi

WORKDIR /build

# Compila whisper.cpp
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF && \
    cmake --build build --config Release

# Scarica il modello LARGE-V3 (cached - ~3GB)
RUN --mount=type=cache,target=/cache/models \
    if [ -f /cache/models/ggml-large-v3.bin ]; then \
        cp /cache/models/ggml-large-v3.bin ./models/; \
    else \
        bash ./models/download-ggml-model.sh large-v3 && \
        cp ./models/ggml-large-v3.bin /cache/models/; \
    fi

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

ENV NODE_ENV=production

# Copia App Node
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# === WHISPER PERSISTENCE ===
# Whisper viene salvato in due posti:
# 1. /app/whisper-backup (interno all'immagine, sempre disponibile)
# 2. /app/whisper (volume, persiste dopo docker system prune)
# L'entrypoint copia dal backup al volume se necessario.

# Backup interno (sopravvive ai rebuild dell'immagine)
RUN mkdir -p /app/whisper-backup
COPY --from=whisper-builder /build/build/bin/whisper-cli /app/whisper-backup/main
COPY --from=whisper-builder /build/models/ggml-large-v3.bin /app/whisper-backup/model.bin
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
