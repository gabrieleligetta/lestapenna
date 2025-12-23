# --- STAGE 1: BUILDER ---
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y python3 python3-pip python3-venv make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn tsc

# --- STAGE 2: RUNNER ---
FROM node:22-slim
WORKDIR /app

# Dipendenze runtime
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install faster-whisper --break-system-packages

# 🔥 MODIFICA QUI: Scarichiamo 'small' invece di 'medium' per velocità
RUN python3 -c "from faster_whisper import download_model; download_model('small')"

# Copia dei file
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY transcribe.py ./

RUN mkdir recordings batch_processing

ENV NODE_ENV=development
CMD ["yarn", "dev"]
