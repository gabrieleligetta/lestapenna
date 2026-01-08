# 🎙️ Stream Audio Architecture & Requirements (v2.0)

> **Project:** Lestapenna (Discord D&D Bot)  
> **Module:** Audio Engine & Storage  
> **Status:** Implemented  
> **Last Update:** Current

Questo documento definisce l'architettura tecnica per la cattura, l'elaborazione e l'archiviazione dei flussi audio provenienti da Discord. Il sistema è progettato per garantire **zero data loss**, **sincronizzazione perfetta** tra le tracce e **resilienza** ai crash.

---

## 1. Obiettivi Architetturali

1.  **Robustezza (Zero Data Loss):** Nessun pacchetto audio deve andare perso, anche in caso di crash del bot o riavvio del server.
2.  **Sincronia Temporale:** Le tracce di utenti diversi devono essere perfettamente allineate nel mix finale, rispettando i silenzi e i ritardi di ingresso.
3.  **Efficienza Storage:** Gestione intelligente dello spazio su disco locale (pulizia aggressiva) e uso gerarchico del Cloud (Oracle Object Storage).
4.  **Qualità Audio:** Normalizzazione standard (EBU R128) per garantire livelli di volume costanti tra utenti diversi.

---

## 2. Core Components

### A. The Pipeline (Per User)
Ogni utente che parla attiva una pipeline dedicata:
1.  **Opus Stream:** Flusso grezzo da Discord.
2.  **Decoder (prism-media):** Decodifica Opus in PCM (Signed 16-bit LE, 48kHz, 2ch).
3.  **Silence Injector (Custom Transform):**
    *   Monitora il delta temporale tra i pacchetti.
    *   Se `delta > 40ms`, inietta buffer di zeri (silenzio digitale) per mantenere il clock audio allineato al clock reale.
    *   *Cruciale per la sincronizzazione.*
4.  **Rotary Encoder (FFmpeg):**
    *   Codifica il PCM in MP3 (64kbps per i chunk).
    *   Viene riavviato ogni 5 minuti (Rotazione) senza interrompere il flusso a monte.

### B. Time Zero (Synchronization)
*   Al momento della connessione del Bot al canale, viene fissato un timestamp immutabile: `sessionStartTimes[sessionId]`.
*   Tutti i calcoli di ritardo (`adelay`) per il mixaggio finale sono relativi a questo Tempo Zero.
*   Formula: `Delay = UserConnectionStart - SessionStart`.

---

## 3. Storage Strategy (The "Three Tiers")

Il sistema utilizza una strategia a tre livelli per salvare i file su Oracle Cloud.

| Tier | Path Cloud | Descrizione | Formato | Retention |
| :--- | :--- | :--- | :--- | :--- |
| **1. Chunk** | `recordings/{sessionId}/chunks/` | Segmenti grezzi di 5 minuti. Backup di sicurezza immediato. | MP3 (64k) | Backup (Low) |
| **2. Fragment** | `recordings/{sessionId}/full/` | Sessione utente unita (connessione -> disconnessione). Normalizzata. Usata per trascrizione. | MP3 (64k, Loudnorm) | Medium |
| **3. Master** | `recordings/{sessionId}/master/` | Mix finale di tutte le tracce sincronizzate. | MP3 (128k, Loudnorm) | Permanent |

---

## 4. Workflows

### 🔄 Workflow 1: Rotazione & Backup (Ogni 5 min)
Garantisce che, se il server esplode, perdiamo al massimo 5 minuti di audio.
1.  Timer scatta.
2.  `SilenceInjector` viene scollegato (`unpipe`) dal vecchio Encoder.
3.  Vecchio Encoder chiuso -> File salvato su disco.
4.  **Upload Immediato** su Oracle (`/chunks/`).
5.  Nuovo Encoder creato.
6.  `SilenceInjector` ricollegato (`pipe`) al nuovo Encoder.
7.  *Nessun pacchetto perso durante lo switch.*

### 🔗 Workflow 2: User Disconnect (Fragment Creation)
Quando un utente esce o il bot si ferma.
1.  Recupero di tutti i **Chunk** locali appartenenti a quella specifica connessione utente.
2.  Generazione file lista per FFmpeg.
3.  **FFmpeg Merge:**
    *   Concatena i chunk.
    *   Applica filtro `loudnorm` (Normalizzazione Audio).
4.  **Upload** del file risultante (`FULL-userId-timestamp.mp3`) su Oracle (`/full/`).
5.  Invio alla coda di trascrizione (`audioQueue`).
6.  Registrazione del file in `completedSessionFiles` con il suo `startTime` preciso.
7.  **Pulizia:** Cancellazione locale dei chunk.

### 🎛️ Workflow 3: Session End (Master Mix)
Quando il comando `$termina` viene invocato.
1.  Attesa chiusura di tutti gli stream attivi (Promise.all).
2.  Recupero lista `completedSessionFiles` per la sessione.
3.  Calcolo `adelay` per ogni traccia: `Math.max(0, file.startTime - sessionStart)`.
4.  **FFmpeg Complex Mix:**
    *   Input: N file Fragment.
    *   Filtri: `[i]adelay=X|X[s i]; ... amix=inputs=N:normalize=0`.
    *   Post-Processing: `loudnorm=I=-16:TP=-1.5:LRA=11` (Standard Podcast/Broadcast).
5.  **Upload** del `MASTER-{sessionId}.mp3` su Oracle (`/master/`).
6.  Generazione Link Presigned per l'email di report.

---

## 5. Recovery & Fallback

### Scenario: Master Mix Fallito o Sessione Vecchia
Se il file Master non viene generato automaticamente (es. crash durante il mix):
1.  L'utente richiede `$scarica <ID>`.
2.  Il sistema controlla Oracle: esiste `MASTER-ID.mp3`?
    *   **SÌ:** Restituisce URL firmato.
    *   **NO:** Attiva `sessionMixer.ts` (Fallback).
3.  **Fallback Logic:**
    *   Scarica tutti i Fragment/Chunk da Oracle.
    *   Ricostruisce il mix localmente usando la stessa logica temporale.
    *   Carica il nuovo Master su Oracle.
    *   Restituisce URL.

### Scenario: Crash durante la registrazione
1.  I file **Chunk** sono già salvi su Oracle (`/chunks/`).
2.  Al riavvio, il comando `$recover` (o script automatico) può scansionare i chunk orfani, unirli e ripristinare lo stato.

---

## 6. File Naming Convention

*   **Chunk:** `{userId}-{timestamp}.mp3`
*   **Fragment (User Session):** `FULL-{userId}-{timestamp}.mp3`
*   **Master:** `MASTER-{sessionId}.mp3`
*   **Transcript:** `transcript-{sessionId}.txt`

---

## 7. Tech Stack

*   **Language:** TypeScript (Node.js)
*   **Audio Libs:** `@discordjs/voice`, `prism-media`
*   **Processing:** `ffmpeg` (static binary via Docker/System)
*   **Storage:** AWS SDK v3 (S3 Client compatible with Oracle Cloud)
*   **Queue:** BullMQ (Redis)
*   **AI:** Whisper.cpp (Transcription), OpenAI/Ollama (Summarization)
