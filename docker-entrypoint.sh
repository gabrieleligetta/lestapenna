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

# Verifica che whisper funzioni
if /app/whisper/main --help > /dev/null 2>&1; then
    echo "[Entrypoint] Whisper OK."
else
    echo "[Entrypoint] ERRORE: Whisper non funziona. Ricopio dal backup..."
    cp -r /app/whisper-backup/* /app/whisper/
    chmod +x /app/whisper/main
fi

# Avvia il comando passato
exec "$@"
