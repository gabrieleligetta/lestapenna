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
*   `/help` / `/aiuto`: Mostra una guida rapida ai comandi.
*   `/status` / `/stato`: Mostra lo stato delle code di elaborazione (Audio, Summary, Correction).
*   `/tones` / `/toni`: Mostra l'elenco dei toni narrativi disponibili.
*   `/setcmd`: Imposta il canale per i comandi (Admin).
*   `/setsummary`: Imposta il canale per i riassunti (Admin).

### 🗺️ Gestione Campagne
*   `/createcampaign` / `/creacampagna <name>`: Crea una nuova campagna.
*   `/selectcampaign` / `/selezionacampagna <name_or_id>`: Attiva una campagna specifica.
*   `/listcampaigns` / `/listacampagne`: Mostra l'elenco delle campagne disponibili.
*   `/deletecampaign` / `/eliminacampagna <name_or_id>`: Elimina una campagna.

### 🎙️ Gestione Sessione
*   `/listen` / `/ascolta [location]`: Il bot entra nel canale vocale e inizia a registrare.
*   `/stoplistening` / `/termina`: Termina la registrazione, avvia la trascrizione e genera il riassunto.
*   `/pause` / `/pausa`: Sospende temporaneamente la registrazione.
*   `/resume` / `/riprendi`: Riprende la registrazione.
*   `/note` / `/nota <text>`: Inserisce una nota testuale manuale nel diario della sessione.
*   `/location` / `/luogo <place>`: Aggiorna il luogo corrente (es. "Castello | Sala del Trono").
*   `/download` / `/scarica <session_id>`: Scarica l'audio completo della sessione.
*   `/downloadtxt` / `/scaricatrascrizioni <session_id>`: Scarica la trascrizione testuale.
*   `/listsessions` / `/listasessioni`: Mostra le ultime sessioni della campagna.
*   `/setsession` / `/impostasessione`: Corregge il numero di una sessione.
*   `/reset`: Forza la rielaborazione di una sessione.
*   `/narrate` / `/racconta`: Genera manualmente un riassunto.
*   `/edittitle` / `/modificatitolo`: Modifica il titolo di una sessione.
*   `/ingest` / `/memorizza`: Forza l'ingestione della memoria.
*   `/travels` / `/viaggi`: Mostra il diario di viaggio.
*   `/atlas` / `/atlante`: Consulta o aggiorna l'Atlante.

### 👥 NPC e Lore
*   `/npc` / `/dossier [name]`: Cerca un NPC o mostra la lista degli ultimi incontrati.
*   `/timeline` / `/cronologia`: Mostra la cronologia degli eventi mondiali.
*   `/timeline-add <year> <description> [type]`: Aggiunge un evento storico.
*   `/date` / `/data <year>`: Imposta l'anno corrente della campagna.
*   `/year0` / `/anno0 <description>`: Imposta l'evento fondante.
*   `/ask` / `/chiedialbardo <question>`: Chiedi al Bardo qualcosa sulla storia.
*   `/wiki` / `/lore <term>`: Cerca frammenti di lore esatti.
*   `/quest` / `/obiettivi`: Visualizza le quest attive.
*   `/quest-add`: Aggiunge una nuova quest.
*   `/quest-done`: Completa una quest.
*   `/inventory` / `/inventario`: Visualizza l'inventario di gruppo.
*   `/loot-add`: Aggiunge un oggetto all'inventario.
*   `/loot-use`: Rimuove o usa un oggetto.

### 👤 Scheda Personaggio
*   `/iam` / `/sono <name>`: Imposta il nome del tuo personaggio.
*   `/myclass` / `/miaclasse <class_name>`: Imposta la tua classe.
*   `/myrace` / `/miarazza <race_name>`: Imposta la tua razza.
*   `/mydesc` / `/miadesc <description>`: Aggiunge una descrizione.
*   `/whoami` / `/chisono`: Visualizza la tua scheda attuale.
*   `/party` / `/compagni`: Visualizza l'elenco di tutti i personaggi.
*   `/resetpg` / `/clearchara`: Cancella la tua scheda personaggio.
*   `/story` / `/storia <name>`: Genera la biografia evolutiva di un PG o NPC.

### 🧪 Debug
*   `/wipe`: Reset totale del sistema (PERICOLO).
*   `/testmail`: Invia una mail di test.

## 🐳 Docker

Puoi eseguire Lestapenna anche tramite Docker:

```bash
docker-compose up -d
```

Assicurati di aver configurato correttamente il file `.env` e `docker-compose.yml`.
