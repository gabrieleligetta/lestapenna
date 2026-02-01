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
*   `$aiuto` / `$help`: Guida rapida e interattiva ai comandi.
*   `$stato`: Verifica lo stato del sistema e delle code di elaborazione (es. trascrizioni).
*   `$metriche`: Statistiche tecniche (utilizzo token, costi IA, durata).

#### 🎙️ Sessione
*   `$ascolta` (o `$listen`): Avvia la registrazione con setup interattivo del luogo.
*   `$stop` (o `$termina`): Chiude la sessione, avvia trascrizione e generazione riassunto.
*   `$listasessioni` (o `$listsessions`): Sfoglia l'archivio, vedi riassunti e scarica file (audio/testo).
*   `$pausa` / `$riprendi`: Sospende e riprende la registrazione audio.
*   `$nota <Testo>`: Inserisce una nota rapida nel log per aiutare l'AI.

#### 🌍 Mondo e Calendario
*   `$setworld` (o `$mondo`): **Menu Configurazione** (Anno, Luogo attuale, Nome Party).
*   `$luogo`: Mostra la posizione attuale del gruppo.
*   `$timeline` (o `$cronologia`): Sfoglia la storia del mondo.

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
Le entità (**NPC, Quest, Atlante, Loot, Bestiario, Fazione**) condividono un'interfaccia interattiva:
*   `$comando`: Lista e ricerca interattiva di record.
*   `$comando add`: Creazione guidata di un nuovo elemento.
*   `$comando update`: Modifica interattiva di campi e note.
*   `$comando merge`: Unione intelligente di duplicati (interattivo).
*   `$comando delete`: Eliminazione sicura (interattiva).
*   `$comando events`: Sfoglia la cronologia degli eventi (interattivo).
*   `$comando #ID`: Visualizzazione rapida della scheda tramite Short ID.

> [!TIP]
> Puoi ancora usare la sintassi rapida per gli aggiornamenti narrativi:
> `$npc update Garlon | È stato visto parlare con una spia.`

#### 🛡️ `$affiliate` (Affiliazioni)
Gestisci i legami tra personaggi/luoghi e le organizzazioni del mondo.
*   `$affiliate`: Avvia il flusso interattivo di associazione.
*   `$affiliate list <Fazione>`: Elenca tutti i membri associati.
*   `$affiliate of <Nome/ID>`: Vedi a quali fazioni appartiene un'entità.

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

## 🛡️ Protezione Dati Manuali

Il sistema distingue tra dati generati dall'AI (sacrificabili) e dati inseriti manualmente (protetti). Le modifiche manuali non vengono mai cancellate durante un `$rebuild`.

### 👤 NPC & Personaggi
*   **Nota Storica**: `$npc update <Nome> | <Tua Nota>` (Aggiunge un evento alla cronologia, l'AI lo integrerà nella bio).
*   **Biografia Fissa**: `$npc <Nome> | <Descrizione Completa>` (Marca l'intero NPC come "Manuale", l'AI non lo toccherà più).

### 🗺️ Altre Entità
*   **Luoghi**: `$atlante update <Macro> - <Micro> | <Nota>` o `$atlante <Macro> - <Micro> | <Descrizione>`.
*   **Quest**: `$quest update <Titolo> | <Progresso>` o `$quest add <Titolo>`.
*   **Loot**: `$loot add <Oggetto>` o `$loot update <Oggetto> | <Nota>`.
*   **Timeline**: Ogni evento aggiunto con `$timeline add` è protetto di default.

> [!IMPORTANT]
> La protezione si applica solo ai dati inseriti o modificati dopo l'aggiornamento del sistema. Per proteggere note vecchie, esegui un piccolo aggiornamento manuale sulla scheda.

---

## 📂 Struttura del Progetto

*   `src/commands`: Definizioni dei comandi.
*   `src/services`: Logica di business (Coda, Audio, Backup).
*   `src/bard`: Modulo AI e Prompting.
*   `src/db`: Gestione Database SQLite.
*   `src/publisher`: Pipeline di generazione contenuti.
