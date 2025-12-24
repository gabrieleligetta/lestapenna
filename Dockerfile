# --- STAGE 1: BUILDER ---
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y python3 python3-pip make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn tsc

# --- STAGE 2: RUNNER (Produzione) ---
FROM node:22-slim
WORKDIR /app

# Dipendenze runtime (ffmpeg, python per Whisper)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install faster-whisper --break-system-packages

# Scarica il modello Whisper 'small' durante la build per averlo nella cache
RUN python3 -c "from faster_whisper import download_model; download_model('small')"

# Copia solo il necessario dalla build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Copiamo transcribe.py perché serve a runtime
COPY transcribe.py ./

# Crea le cartelle necessarie
RUN mkdir recordings batch_processing data

ENV NODE_ENV=production
# ENV per collegarsi a Ollama nel container separato
ENV OLLAMA_BASE_URL=http://ollama:11434/v1
ENV AI_PROVIDER=ollama

# Comando di avvio produzione
CMD ["node", "dist/index.js"]
