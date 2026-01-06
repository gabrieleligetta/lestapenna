#!/bin/bash

# ==========================================
# SCRIPT DI AGGIORNAMENTO COOKIE (Lestapenna)
# ==========================================

# --- CONFIGURAZIONE UTENTE ---
SERVER_IP="129.152.10.9"
SSH_USER="ubuntu"
KEY_PATH="/Users/gligetta/oracle_bot_key"

# Percorsi Locali
LOCAL_COOKIES_PATH="/Users/gligetta/www/lestapenna/cookies.json"

# Percorsi Remoti (Assumendo che il progetto sia in ~/lestapenna)
REMOTE_DIR="/home/ubuntu/lestapenna"
REMOTE_COOKIES_PATH="$REMOTE_DIR/cookies.json"
DOCKER_SERVICE_NAME="dnd-bot"

# ==========================================

echo "🔍 Controllo file locale: $LOCAL_COOKIES_PATH"

# 1. Controlla se il file esiste
if [ ! -f "$LOCAL_COOKIES_PATH" ]; then
    echo "❌ Errore: Non trovo il file cookies.json!"
    echo "👉 Assicurati di averlo salvato in: $LOCAL_COOKIES_PATH"
    exit 1
fi

echo "🚀 Caricamento nuovi cookie sul server ($SERVER_IP)..."

# 2. Carica il file via SCP
scp -i "$KEY_PATH" "$LOCAL_COOKIES_PATH" $SSH_USER@$SERVER_IP:$REMOTE_COOKIES_PATH

if [ $? -ne 0 ]; then
    echo "❌ Errore durante il caricamento SCP. Controlla la chiave SSH e la connessione."
    exit 1
fi

# 3. Riavvia il container per applicare le modifiche
echo "🔄 Riavvio del servizio $DOCKER_SERVICE_NAME..."
ssh -i "$KEY_PATH" $SSH_USER@$SERVER_IP "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml restart $DOCKER_SERVICE_NAME"

echo "✅ Fatto! Bot aggiornato con nuovi cookie."
