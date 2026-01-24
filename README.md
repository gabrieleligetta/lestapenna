# 🖋️ Lestapenna - Il Bardo Digitale

**Lestapenna** è un bot Discord avanzato progettato per registrare, trascrivere e narrare le tue sessioni di gioco di ruolo (D&D, Pathfinder, ecc.). Utilizza l'intelligenza artificiale per generare riassunti epici, mantenere traccia della storia, gestire la conoscenza del mondo (Lore) e rispondere a domande sulla campagna.

## 🚀 Funzionalità Principali

*   **Registrazione Audio**: Registra l'audio di tutti i partecipanti nel canale vocale con mixing intelligente.
*   **Trascrizione Automatica**: Converte l'audio in testo utilizzando modelli di riconoscimento vocale avanzati.
*   **Architettura a Servizi**: Sistema modulare per la gestione di code, eventi e pipeline di elaborazione.
*   **Riassunti Narrativi**: Genera riassunti della sessione in vari stili (Cronaca, Epico, Oscuro, ecc.) usando LLM (OpenAI/Google Gemini).
*   **Memoria a Lungo Termine (RAG)**: Indicizza eventi, NPC e luoghi per rispondere a domande ("Cosa è successo a Waterdeep?").
*   **Atlante & Dossier**: Gestione automatica e manuale di Luoghi e NPC, con riconciliazione intelligente dei duplicati.
*   **Time Travel & Recovery**: Strumenti avanzati per rigenerare la storia passata o recuperare sessioni interrotte.
*   **Backup Cloud**: Archiviazione sicura su Oracle Cloud Object Storage.

## 🛠️ Installazione e Configurazione

### Prerequisiti

*   Node.js (v18+)
*   Redis (per la gestione delle code)
*   FFmpeg installato e nel PATH
*   Bot Discord configurato nel [Developer Portal](https://discord.com/developers/applications) con privilegi di amministratore e intenti privilegiati (Message Content, Guild Members, Voice States).

### Setup Variabili d'Ambiente (.env)

Copia il file `.env.example` in `.env`. Le configurazioni chiave includono:

```env
# Discord
DISCORD_BOT_TOKEN=il_tuo_token_discord
DISCORD_DEVELOPER_ID=id_utente_admin_bot

# AI Provider (openai | bard)
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
# o per Google Gemini
# GOOGLE_API_KEY=...

# Storage
ORACLE_BUCKET_NAME=...
# ... credenziali Oracle
```

### Avvio

```bash
# Installazione dipendenze
npm install

# Avvio in modalità sviluppo
npm run dev

# Avvio con Docker
docker-compose up -d
```

## 📖 Guida ai Comandi

Tutti i comandi iniziano con il prefisso `$`.

### ℹ️ Generale

*   `$aiuto` / `$help`: Mostra l'elenco dei comandi.
*   `$stato` / `$status`: Mostra lo stato delle code di elaborazione e dei servizi.
*   `$metriche` / `$metrics`: Visualizza statistiche tecniche della sessione corrente (utilizzo risorse, costi stimati).

### 🗺️ Gestione Campagne

Il sistema supporta multiple campagne per server.

*   `$creacampagna <Nome>`: Crea una nuova campagna.
*   `$selezionacampagna <Nome>`: Attiva una campagna.
*   `$listacampagne`: Elenco delle campagne disponibili.
*   `$eliminacampagna <Nome>`: Cancella una campagna (Irreversibile).
*   `$autoaggiorna [on|off]`: Abilita/Disabilita l'aggiornamento automatico delle bio dei PG basato sugli eventi di sessione.

### 🎙️ Sessione di Gioco

*   `$ascolta [Luogo]` (o `$listen`): Il bot entra in vocale e inizia a registrare.
    *   Es: `$ascolta Locanda del Pony`
*   `$pausa` / `$riprendi`: Sospende/Riprende la registrazione.
*   `$nota <Testo>`: Aggiunge una nota manuale al log della sessione (utile per evidenziare momenti chiave).
*   `$termina` (o `$stop`): Conclude la sessione, avvia la trascrizione e la generazione del riassunto.

### 📜 Narrazione e Storia

*   `$racconta <ID_SESSIONE> [tono]`: Rigenera il riassunto di una sessione passata.
    *   Toni: `DM`, `EPIC`, `DARK`, `COMIC`, ecc.
*   `$chiedialbardo <Domanda>` (o `$ask`): Interroga la memoria del bot sulla storia della campagna.
*   `$wiki <Termine>`: Ricerca testuale diretta negli archivi.
*   `$timeline` / `$cronologia`: Gestione degli eventi storici.
    *   `$timeline add <Anno> | <Tipo> | <Descrizione>`
*   `$anno0 <Descrizione>` / `$data <Anno>`: Gestione del calendario di gioco.

#### Gestione Personaggi (PG)

*   `$sono <Nome>`: Associa il tuo utente Discord a un PG.
*   `$storia <Nome>`: Mostra la storia narrata di un PG o NPC.
    *   `$storia sync`: Forza l'aggiornamento delle storie di tutti i PG in base agli ultimi eventi.
*   `$bio reset [Nome]`: **[Distruttivo]** Rigenera completamente la biografia di un PG riscrivendola da zero basandosi su *tutta* la storia della campagna.

### 👥 Atlante e NPC (Mondo Dinamico)

Il bot popola automaticamente questi database, ma puoi curarli manualmente.

*   `$atlante` (o `$location`): Gestione luoghi.
    *   `$atlante sync [all|Nome]`: Forza la sincronizzazione RAG per i luoghi.
    *   `$atlante rename ...`: Rinomina luoghi correggendo anche la storia passata.
*   `$npc` (o `$dossier`): Gestione PNG.
    *   `$npc merge <Vecchio> | <Nuovo>`: Unisce due NPC duplicati.
    *   `$npc sync [all|Nome]`: Forza la sincronizzazione RAG per gli NPC.
    *   `$npc update ...`: Modifica attributi manuali (Ruolo, Status).
*   `$bestiario`: Catalogo dei mostri incontrati.

### 🔧 Amministrazione e Manutenzione (Avanzato)

Questi comandi sono riservati allo sviluppatore o all'admin del bot.

#### 🔄 Recupero e Time Travel (`$recover`)

*   `$recover <ID_SESSIONE>`: Tenta di recuperare una sessione bloccata o in errore, riprendendo dall'ultima fase valida.
*   `$recover regenerate-all`: **Time Travel**. Rianalizza l'intera cronologia della campagna per rigenerare e sincronizzare massivamente tutte le biografie dei PG, le schede NPC e le voci dell'Atlante. Usare con cautela su campagne molto lunghe.

#### 🧹 Pulizia (`$wipe`)

*   `$wipe softwipe`: **Soft Reset**. Cancella tutta la memoria derivata (RAG, Inventario, Quest, Storie PG/NPC) e svuota la coda Redis.
    *   *Cosa rimane*: Campagne, Sessioni, File Audio, PG.
    *   *Uso*: Utile per rigenerare la conoscenza (`$recover regenerate-all`) senza perdere i dati grezzi.
*   `$wipe wipe`: **RAGNAROK (Hard Reset)**. Cancella **TUTTO**: Database, File locali, Backup Cloud, Code. **Irreversibile**. Riporta il bot allo stato iniziale.

#### 💾 Download Dati

*   `$scarica <ID_SESSIONE>`: Genera e fornisce il link per scaricare l'audio masterizzato della sessione.
*   `$scaricatrascrizioni`: *Deprecato/Rimosso*. Le trascrizioni sono gestite internamente per la generazione dei riassunti.

---

## 📂 Struttura del Progetto

*   `src/commands`: Definizioni dei comandi.
*   `src/services`: Logica di business (Coda, Audio, Backup).
*   `src/bard`: Modulo AI e Prompting.
*   `src/db`: Gestione Database SQLite.
*   `src/publisher`: Pipeline di generazione contenuti.
