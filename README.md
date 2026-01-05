# 🖋️ Lestapenna - Il Bardo Digitale

Lestapenna è un bot Discord avanzato progettato per registrare, trascrivere e narrare le tue sessioni di gioco di ruolo (D&D, Pathfinder, ecc.). Utilizza l'intelligenza artificiale per generare riassunti epici, mantenere traccia della storia e rispondere a domande sulla lore della campagna.

## 🚀 Funzionalità Principali

*   **Registrazione Audio**: Registra l'audio di tutti i partecipanti nel canale vocale.
*   **Trascrizione Automatica**: Converte l'audio in testo utilizzando modelli di riconoscimento vocale.
*   **Riassunti Narrativi**: Genera riassunti della sessione in vari stili (Cronaca, Epico, Oscuro, ecc.) usando l'IA.
*   **Gestione Campagne**: Supporta multiple campagne e profili personaggio per ogni server.
*   **Memoria a Lungo Termine**: Indicizza gli eventi passati per rispondere a domande sulla storia ("Cosa è successo a Waterdeep?").
*   **Archivio Cloud**: Backup automatico delle registrazioni su Oracle Cloud Object Storage.

## 🛠️ Installazione e Configurazione

### Prerequisiti

*   Node.js (v18+)
*   Python 3.8+ (per i worker di trascrizione)
*   FFmpeg installato e nel PATH
*   Un bot Discord creato nel [Developer Portal](https://discord.com/developers/applications)
*   Chiavi API per OpenAI/Google Gemini (Bard)
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
    # ... altri parametri (vedi .env.example)
    ```

4.  **Avvia il bot**:
    ```bash
    npm run start
    # Oppure in modalità sviluppo
    npm run dev
    ```

## 📖 Guida ai Comandi

Tutti i comandi iniziano con il prefisso `!`.

### ℹ️ Generale
*   `!help` (o `!aiuto`): Mostra un messaggio riassuntivo con i comandi principali direttamente su Discord.

### 🗺️ Gestione Campagne
Prima di iniziare, devi creare o selezionare una campagna.

*   `!creacampagna <Nome>`: Crea una nuova campagna per il server.
*   `!selezionacampagna <Nome>` (o `!setcampagna`): Attiva una campagna specifica.
*   `!listacampagne`: Mostra l'elenco delle campagne disponibili.

### 🎙️ Gestione Sessione
*   `!ascolta` (o `!listen`): Il bot entra nel canale vocale e inizia a registrare. **Richiede una campagna attiva.**
*   `!termina` (o `!stoplistening`): Termina la registrazione, avvia la trascrizione e genera il riassunto.
*   `!impostasessione <N>` (o `!setsession`): Imposta manualmente il numero della sessione corrente.
*   `!impostasessioneid <ID> <N>`: Corregge il numero di sessione per uno specifico ID sessione.
*   `!reset <ID>`: Forza la rielaborazione completa di una sessione (utile in caso di errori).

### 👤 Scheda Personaggio
Ogni giocatore può definire il proprio personaggio per la campagna attiva. Questo aiuta l'IA a attribuire correttamente le azioni.

*   `!sono <Nome>` (o `!iam`): Imposta il nome del tuo personaggio.
*   `!miaclasse <Classe>` (o `!myclass`): Imposta la tua classe (es. Barbaro, Mago).
*   `!miarazza <Razza>` (o `!myrace`): Imposta la tua razza (es. Elfo, Nano).
*   `!miadesc <Testo>` (o `!mydesc`): Aggiunge una breve descrizione fisica o caratteriale.
*   `!chisono` (o `!whoami`): Visualizza la tua scheda attuale.

### 📜 Narrazione e Archivi
*   `!racconta <ID_SESSIONE> [tono]`: Rigenera il riassunto di una sessione passata.
*   `!toni`: Mostra l'elenco dei toni narrativi disponibili (es. DM, EPIC, DARK, COMIC).
*   `!listasessioni`: Mostra le ultime sessioni registrate per la campagna attiva.
*   `!chiedialbardo <Domanda>` (o `!ask`): Fai una domanda al Bardo sulla storia della campagna (es. "Chi abbiamo incontrato alla taverna?").
*   `!memorizza <ID>` (o `!ingest`): Forza l'apprendimento degli eventi di una specifica sessione. Utile se il bot non sembra ricordare cosa è successo in una sessione passata o se l'ingestione automatica è fallita. Dopo aver eseguito questo comando, il bot potrà rispondere a domande su quella sessione tramite `!chiedialbardo`.
*   `!scarica <ID_SESSIONE>` (o `!download`): Richiede il file audio completo della sessione (mixato).
*   `!scaricatrascrizioni <ID_SESSIONE>` (o `!downloadtxt`): Scarica il file di testo con la trascrizione completa.

### ⚙️ Configurazione Server
*   `!setcmd`: Imposta il canale testuale corrente come canale per i comandi del bot.
*   `!setsummary`: Imposta il canale testuale corrente per la pubblicazione dei riassunti.

### 🧪 Debug e Test
*   `!teststream <URL>`: Simula una sessione scaricando un file audio da un URL.
*   `!cleantest`: Rimuove tutte le sessioni di test dal database.

## 🐳 Docker

Puoi eseguire Lestapenna anche tramite Docker:

```bash
docker-compose up -d
```

Assicurati di aver configurato correttamente il file `.env` e `docker-compose.yml`.

## 📝 Note
*   Il bot ignora l'audio di altri bot presenti nel canale vocale.
*   Se tutti gli utenti umani lasciano il canale vocale, il bot si disconnetterà automaticamente dopo 60 secondi, salvando la sessione.
