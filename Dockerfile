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
WORKDIR /build

# AGGIUNTO 'cmake': Richiesto per la compilazione delle nuove versioni di whisper.cpp
RUN apt-get update && apt-get install -y build-essential git make curl cmake && rm -rf /var/lib/apt/lists/*

# Clona e compila whisper.cpp con GCC 10 (Bullseye) che non ha il bug FP16
# NOTA: Aggiunto -DBUILD_SHARED_LIBS=OFF per includere la libreria nell'eseguibile
RUN git clone https://github.com/ggerganov/whisper.cpp.git . && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF && \
    cmake --build build --config Release

# Scarica il modello MEDIUM
RUN bash ./models/download-ggml-model.sh medium

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

# Copia Whisper (compilato con Bullseye GCC 10)
RUN mkdir -p /app/whisper
# FIX: Copiamo 'whisper-cli' (il nuovo binario) ma lo salviamo come 'main'
# per mantenere la compatibilità con il codice TypeScript esistente.
COPY --from=whisper-builder /build/build/bin/whisper-cli /app/whisper/main
COPY --from=whisper-builder /build/models/ggml-medium.bin /app/whisper/model.bin

# Assicuriamo i permessi di esecuzione
RUN chmod +x /app/whisper/main

# Cartelle dati
RUN mkdir -p recordings batch_processing data mixed_sessions

CMD ["node", "dist/index.js"]
