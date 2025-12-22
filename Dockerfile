# --- STAGE 1: BUILDER ---
FROM node:22-slim AS builder

WORKDIR /app

# Installiamo i compilatori
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./

# Installiamo dipendenze node
RUN yarn install --frozen-lockfile

COPY . .

# Compiliamo TS
RUN yarn tsc

# Pulizia deps
RUN yarn install --production --ignore-scripts --prefer-offline

# --- STAGE 2: PRODUCTION RUNNER ---
FROM node:22-slim

WORKDIR /app

# 1. Installiamo FFmpeg, Python e PIP (per Whisper locale)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*

# 2. Installiamo la libreria Python 'faster-whisper' (è magica su CPU)
# L'opzione --break-system-packages serve sulle nuove versioni di Debian/Ubuntu
RUN pip3 install faster-whisper --break-system-packages

# 3. Copiamo i file node
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

COPY transcribe.py ./

RUN mkdir recordings batch_processing

ENV NODE_ENV=production
USER root
# Nota: Usiamo root temporaneamente per evitare problemi di permessi tra Python/Node,
# in produzione ideale si usa utente 'node' ma con i permessi giustati.

CMD ["node", "dist/index.js"]
