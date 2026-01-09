# 🖋️ Lestapenna - Il Bardo Digitale (NestJS Edition)

Lestapenna è un bot Discord avanzato progettato per registrare, trascrivere e narrare le tue sessioni di gioco di ruolo (D&D, Pathfinder, ecc.). Utilizza l'intelligenza artificiale per generare riassunti epici, mantenere traccia della storia e rispondere a domande sulla lore della campagna.

> **Nota**: Questa versione è stata migrata a **NestJS** per maggiore stabilità e scalabilità. I comandi sono ora **Slash Commands** (`/`).

## 🚀 Funzionalità Principali

*   **Registrazione Audio**: Registra l'audio di tutti i partecipanti nel canale vocale.
*   **Trascrizione Automatica**: Converte l'audio in testo utilizzando modelli di riconoscimento vocale (Whisper).
*   **Riassunti Narrativi**: Genera riassunti della sessione in vari stili (Cronaca, Epico, Oscuro, ecc.) usando l'IA.
*   **Gestione Campagne**: Supporta multiple campagne e profili personaggio per ogni server.
*   **Memoria a Lungo Termine**: Indicizza gli eventi passati per rispondere a domande sulla storia.
*   **Archivio Cloud**: Backup automatico delle registrazioni su Oracle Cloud Object Storage.
*   **Tracciamento Luoghi (Atlas)**: Mantiene memoria dei luoghi visitati.

## 🛠️ Installazione e Configurazione

### Prerequisiti

*   Node.js (v18+)
*   Python 3.8+ (per i worker di trascrizione)
*   FFmpeg installato e nel PATH
*   Redis (per le code di elaborazione)
*   Un bot Discord creato nel [Developer Portal](https://discord.com/developers/applications)
*   Chiavi API per OpenAI
*   Bucket Oracle Cloud (opzionale, per backup)

### Setup

1.  **Clona il repository**:
    ```bash
    git clone https://github.com/tuo-utente/lestapenna.git
    cd lestapenna
    ```

2.  **Installa le dipendenze**:
    ```bash
    npm install
    ```

3.  **Configura le variabili d'ambiente**:
    Copia il file `.env.example` in `.env` e compila i campi richiesti:
    ```env
    DISCORD_BOT_TOKEN=il_tuo_token
    OPENAI_API_KEY=la_tua_chiave
    REDIS_HOST=localhost
    REDIS_PORT=6379
    # ... altri parametri OCI
    ```

4.  **Avvia il bot**:
    ```bash
    npm run start
    # Oppure in modalità sviluppo
    npm run dev
    ```

## 📖 Guida ai Comandi (Slash Commands)

Tutti i comandi sono ora Slash Commands. Digita `/` su Discord per vedere l'elenco completo e i parametri.

### ℹ️ Sistema
*   `/help`: Mostra una guida rapida ai comandi.
*   `/status`: Mostra lo stato delle code di elaborazione (Audio, Summary, Correction).
*   `/tones`: Mostra l'elenco dei toni narrativi disponibili.
*   `/config-set-channel`: Imposta i canali per i comandi o i riassunti (Admin).

### 🗺️ Gestione Campagne
*   `/campaign-create <name>`: Crea una nuova campagna.
*   `/campaign-select <name_or_id>`: Attiva una campagna specifica.
*   `/campaign-list`: Mostra l'elenco delle campagne disponibili.

### 🎙️ Gestione Sessione
*   `/session-start [location]`: Il bot entra nel canale vocale e inizia a registrare.
*   `/session-stop`: Termina la registrazione, avvia la trascrizione e genera il riassunto.
*   `/session-pause`: Sospende temporaneamente la registrazione.
*   `/session-resume`: Riprende la registrazione.
*   `/note <text>`: Inserisce una nota testuale manuale nel diario della sessione.
*   `/location <place>`: Aggiorna il luogo corrente (es. "Castello | Sala del Trono").
*   `/session-download <session_id>`: Scarica l'audio completo della sessione.
*   `/session-transcript <session_id>`: Scarica la trascrizione testuale.
*   `/session-list`: Mostra le ultime sessioni della campagna.
*   `/session-set-number`: Corregge il numero di una sessione.
*   `/session-reset`: Forza la rielaborazione di una sessione.

### 👥 NPC e Lore
*   `/npc [name]`: Cerca un NPC o mostra la lista degli ultimi incontrati.
*   `/timeline-view`: Mostra la cronologia degli eventi mondiali.
*   `/timeline-add <year> <description> [type]`: Aggiunge un evento storico.
*   `/set-date <year>`: Imposta l'anno corrente della campagna.

### 👤 Scheda Personaggio
*   `/iam <name>`: Imposta il nome del tuo personaggio.
*   `/myclass <class_name>`: Imposta la tua classe.
*   `/myrace <race_name>`: Imposta la tua razza.
*   `/mydesc <description>`: Aggiunge una descrizione.
*   `/whoami`: Visualizza la tua scheda attuale.
*   `/party`: Visualizza l'elenco di tutti i personaggi.
*   `/resetpg`: Cancella la tua scheda personaggio.

### 🧪 Debug
*   `/test-stream <url>`: Simula una sessione scaricando un file audio da un URL.
*   `/clean-test`: Rimuove tutte le sessioni di test.

## 🐳 Docker

Puoi eseguire Lestapenna anche tramite Docker:

```bash
docker-compose up -d
```

Assicurati di aver configurato correttamente il file `.env` e `docker-compose.yml`.
