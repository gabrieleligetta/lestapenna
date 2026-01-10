# FILE: Dockerfile

# --- STAGE 1: NODE BUILDER ---
FROM node:22-bullseye AS builder
WORKDIR /app

# Tool di base
RUN apt-get update && apt-get install -y build-essential git python3 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# Rimuoviamo yarn.lock per forzare la rigenerazione e copiamo tutto
RUN yarn install
COPY . .
RUN yarn build

# --- STAGE 2: WHISPER COMPILER (ARM OPTIMIZED) ---
FROM debian:bullseye-slim AS whisper-builder
WORKDIR /build

# cmake e build tools necessari
RUN apt-get update && apt-get install -y build-essential git make curl cmake && rm -rf /var/lib/apt/lists/*

# Clona whisper.cpp
# NOTA: Su macchine Ampere (ARM64), cmake rileva automaticamente le istruzioni NEON per l'accelerazione.
# Disabilitiamo BUILD_SHARED_LIBS per avere un binario statico più facile da spostare.
RUN git clone https://github.com/ggerganov/whisper.cpp.git . && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF && \
    cmake --build build --config Release --parallel 4

# Scarica il modello (MEDIUM è il massimo raccomandato per CPU inference realtime accettabile)
RUN bash ./models/download-ggml-model.sh medium

# --- STAGE 3: PRODUCTION RUNNER ---
FROM node:22-bullseye-slim
WORKDIR /app

# Dipendenze runtime (libgomp1 è CRUCIALE per whisper.cpp su questa architettura)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    procps \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installiamo yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

ENV NODE_ENV=production

# Copia App Node
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copia Whisper
RUN mkdir -p /app/whisper

# IMPORTANTE: Il binario compilato si trova in build/bin/whisper-cli (nelle versioni recenti)
# Lo rinominiamo in 'main' perché il tuo codice TypeScript (src/audio/audio.service.ts) probabilmente chiama 'main'
COPY --from=whisper-builder /build/build/bin/whisper-cli /app/whisper/main
COPY --from=whisper-builder /build/models/ggml-medium.bin /app/whisper/model.bin

# Permessi
RUN chmod +x /app/whisper/main

# Creazione cartelle dati necessarie al runtime
RUN mkdir -p recordings batch_processing data

EXPOSE 3000

CMD ["node", "dist/main.js"]
