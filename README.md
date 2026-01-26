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

### 🔰 1. Comandi Semplici (Base)
*Comandi essenziali per l'uso quotidiano durante la sessione.*

#### ℹ️ Generale
*   `$aiuto` / `$help`: Mostra la lista rapida dei comandi.
*   `$stato`: Verifica lo stato delle code di elaborazione (es. trascrizioni in corso).
*   `$metriche`: Visualizza statistiche tecniche della sessione (utilizzo token, costi, durata).

#### 🎙️ Sessione
*   `$ascolta [Luogo]` (o `$listen`): Il bot entra in vocale e inizia a registrare.
    *   Es: `$ascolta Locanda del Puledro Impennato`
*   `$pausa` / `$riprendi`: Sospende e riprende la registrazione audio.
*   `$nota <Testo>`: Inserisce una nota manuale nel log (utile per aiutare l'AI sui nomi propri o eventi chiave).
*   `$stop` / `$termina`: Chiude la sessione, avvia trascrizione e generazione riassunto.

#### 🌍 Luogo e Atmosfera
*   `$luogo`: Mostra dove si trova il gruppo attualmente.
*   `$luogo <Regione> | <Dettaglio>`: Imposta manualmente la posizione attuale.
    *   Es: `$luogo Neverwinter | I Quartieri Alti`

#### 📜 Narrazione e Storia
*   `$racconta <ID> [tono] [force]`: Rigenera il riassunto di una sessione passata. Aggiungi `force` per rigenerare anche il testo AI.
    *   Toni: `DM`, `EPIC`, `DARK`, `COMIC`.
*   `$chiedialbardo <Domanda>`: Chiedi qualsiasi cosa sulla storia della campagna (Il Bardo cercherà nella sua memoria).
*   `$wiki <Termine>`: Cerca informazioni specifiche negli archivi.

#### 👤 Il Tuo Personaggio
*   `$sono <NomePG>`: Associa il tuo account Discord a un personaggio.
*   `$chisono` (o `$whoami`): Visualizza la tua scheda personaggio (se associata).
*   `$compagni` (o `$party`): Visualizza l'elenco degli avventurieri nel party.
*   `$storia <NomePG>`: Leggi la storia del tuo PG narrata dal Bardo.
*   `$bio reset [NomePG]`: **[Avanzato]** Forza la rigenerazione completa della biografia del PG rileggendo tutta la storia della campagna.

---

### 🛠️ 2. Comandi Avanzati & Gestione Mondo
*Strumenti di world-building per il DM. Interfaccia unificata per tutte le entità.*

#### 🧩 Sintassi Unificata Entità
Le entità (**NPC, Quest, Luoghi, Oggetti, Mostri**) condividono gli stessi comandi base:
*   `$comando list`: Elenco completo.
*   `$comando #ID`: Vedi dettagli scheda (es. `$npc 1`).
*   `$comando <Nome>`: Cerca per nome (es. `$npc Garlon`).
*   `$comando update <Nome/ID> | <Nota>`: Aggiunge un evento/osservazione alla storia dell'entità.
*   `$comando delete <Nome/ID>`: Elimina l'entità.
*   `$comando merge <Old> | <New>`: Unisce due entità (trasferisce storia e dettagli).

#### 👥 `$npc` (Personaggi Non Giocanti)
*   **Creazione**: `$npc add <Nome> | <Ruolo> | <Descrizione>`
*   **Alias**: `$npc alias <Nome> | add | <Soprannome>` (es. "Il Rosso").
*   **Metadati**: `$npc update <Nome> field:<campo> <valore>`
    *   `field:status`: `ALIVE`, `DEAD`, `MISSING`.
    *   `field:role`: Cambia ruolo (es. "Re").
    *   `field:name`: Rinomina e aggiorna RAG.
*   **Rigenerazione**: `$npc regen <Nome>` (Riscrive la scheda basandosi sulla storia).

#### 🗺️ `$atlante` (Luoghi)
*   **Aggiornamento**: `$atlante update <Regione> | <Luogo> | <Nota>`
    *   Es: `$atlante Costa della Spada | Neverwinter | La città è in festa.`
*   Non richiede creazione esplicita: il primo update o `$luogo` crea la voce.

#### ⚔️ `$quest` (Missioni)
*   **Nuova**: `$quest add <Titolo>`
*   **Aggiornamento**: `$quest update <Titolo> | <Progresso>`
*   **Completamento**: `$quest done <Titolo>` (La segna come completata e la narra).

#### 🎒 `$loot` (Inventario di Gruppo)
*   **Aggiungi**: `$loot add <Oggetto>`
*   **Usa/Consuma**: `$loot use <Oggetto>` (Rimuove una quantità).
*   **Dettagli**: `$loot update <Oggetto> | <Descrizione>`

#### 👹 `$bestiario` (Mostri)
*   **Aggiornamento**: `$bestiario update <Mostro> | <Osservazione tattica>`
*   **Lista**: Mostra automaticamente i mostri divisi per stato (Vivi, Sconfitti, Fuggiti).

#### ⏳ Timeline e Data
*   `$data <Anno>`: Imposta l'anno corrente (D.E. positivi, P.E. negativi).
*   `$anno0 <Descrizione>`: Definisce l'evento cardine per l'anno 0.
*   `$timeline add <Anno> | <Tipo> | <Descrizione>`: Inserisce evento storico.
    *   Tipi: `WAR`, `POLITICS`, `DISCOVERY`, `CALAMITY`, `GENERIC`.
*   `$viaggi fix`: Correzione manuale del log spostamenti (es. `$viaggi fix #ID | NuovaRegione | NuovoLuogo`).

#### 🔧 Amministrazione e Config
*   `$impostasessione <N>`: Forza il numero della sessione attuale.
*   `$autoaggiorna on/off`: Abilita/Disabilita l'aggiornamento automatico delle biografie dei PG.
*   `$setcmd`: Imposta il canale corrente come canale comandi.
*   `$setsummary`: Imposta il canale corrente per i riassunti.
*   `$memorizza <ID_SESSIONE>`: Avvia l'ingestione manuale di una vecchia sessione (senza audio).
*   `$scarica <ID_SESSIONE>`: Link download audio masterizzato (file master.mp3).
*   `$presenze <ID_SESSIONE>`: Elenca gli NPC incontrati in quella specifica sessione.

#### ⚠️ Area Pericolo (Admin)
*   `$recover <ID>`: Tenta di ripristinare una sessione bloccata.
*   `$recover regenerate-all`: **Time Travel**. Rilancia l'elaborazione di TUTTA la campagna per rigenerare le entità.
*   `$wipe`: Cancella database e memoria (vari livelli di distruzione).
*   `$scarica <ID>`: Link download audio masterizzato.

---

### 👨‍💻 3. Comandi Sviluppatore (Dev Tools)
*Strumenti di debug per lo sviluppatore. Accessibili via `$help dev`.*

*   `$debug teststream <URL>`: Simula una sessione scaricando un file audio da URL.
*   `$debug testmail`: Invia un report di test via email.
*   `$rebuild CONFIRM [FORCE]`: **[CRITICO]** Re-indicizza l'intero database e rigenera tutte le entità dai log. Aggiungi `FORCE` per rigenerare anche i riassunti AI.
*   `$riprocessa <ID> [FORCE]`: Rigenera i dati di una singola sessione (RAG, eventi) preservando la trascrizione. Aggiungi `FORCE` per rigenerare anche il riassunto AI.
*   `$resetpg` (o `$clearchara`): Cancella definitivamente la scheda del PG dell'utente.
*   `$wipe softwipe`: Pulisce solo i dati derivati (RAG, bio PG) mantenendo sessioni e anagrafiche.

---

## 📂 Struttura del Progetto

*   `src/commands`: Definizioni dei comandi.
*   `src/services`: Logica di business (Coda, Audio, Backup).
*   `src/bard`: Modulo AI e Prompting.
*   `src/db`: Gestione Database SQLite.
*   `src/publisher`: Pipeline di generazione contenuti.
