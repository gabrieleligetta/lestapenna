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

# Installiamo dipendenze di sistema (FFmpeg, Python)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install faster-whisper --break-system-packages

# 🔥 NUOVA RIGA: Scarichiamo il modello ORA (durante la build) invece che dopo
# Nota: Se nel file transcribe.py usi "small" o "base", cambia 'medium' qui sotto!
RUN python3 -c "from faster_whisper import download_model; download_model('medium')"

# Copiamo tutto dal builder (inclusi node_modules completi con devDependencies per nodemon)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# IMPORTANTE: Copiamo anche src per permettere a nodemon di guardare i file TS
COPY --from=builder /app/src ./src
COPY transcribe.py ./
RUN mkdir recordings batch_processing

# Variabile d'ambiente per decidere se usare nodemon o node
ENV NODE_ENV=development

# Se siamo in dev usa "yarn dev", altrimenti "yarn start"
CMD ["yarn", "dev"]
