#!/bin/bash
set -e

# === WHISPER PERSISTENCE ===
# Se il volume whisper è vuoto, copia dal backup interno
if [ ! -f "/app/whisper/main" ]; then
    echo "[Entrypoint] Whisper non trovato nel volume. Copio dal backup..."
    cp -r /app/whisper-backup/* /app/whisper/
    chmod +x /app/whisper/main
    echo "[Entrypoint] Whisper copiato con successo!"
else
    echo "[Entrypoint] Whisper già presente nel volume."
fi

# Copia modello distil-it se non presente nel volume
if [ -f "/app/whisper-backup/model-distil-it.bin" ] && [ ! -f "/app/whisper/model-distil-it.bin" ]; then
    echo "[Entrypoint] Copio modello distil-it-v0.2 (~530MB)..."
    cp /app/whisper-backup/model-distil-it.bin /app/whisper/model-distil-it.bin
    echo "[Entrypoint] Modello distil-it copiato!"
fi

# Verifica che whisper funzioni
if /app/whisper/main --help > /dev/null 2>&1; then
    echo "[Entrypoint] Whisper OK."
else
    echo "[Entrypoint] ERRORE: Whisper non funziona. Ricopio dal backup..."
    cp -r /app/whisper-backup/* /app/whisper/
    chmod +x /app/whisper/main
fi

# Log modello attivo
DISTIL_IT="${WHISPER_DISTIL_IT:-true}"
if [ "$DISTIL_IT" = "true" ] && [ -f "/app/whisper/model-distil-it.bin" ]; then
    echo "[Entrypoint] 🇮🇹 Modello attivo: distil-it-v0.2 (Q5_0, ~530MB)"
else
    echo "[Entrypoint] 🌍 Modello attivo: large-v3 (~3GB)"
fi

# Avvia il comando passato
exec "$@"
