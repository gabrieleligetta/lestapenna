import {
    getSessionTranscript,
    getUserProfile,
    getSessionStartTime,
    getSessionCampaignId,
    getCampaignById,
    getCampaignCharacters,
    getSessionNotes,
    LocationState,
    getAtlasEntry,
    getCharacterHistory,
    getNpcHistory,
    getCampaignSnapshot
} from '../db';
import {
    openai,
    openAiClient,
    ollamaClient,
    MODEL_NAME,
    FAST_MODEL_NAME,
    LOCAL_CORRECTION_MODEL,
    OPEN_AI_MODEL_NANO,
    TRANSCRIPTION_PROVIDER,
    ENABLE_AI_TRANSCRIPTION_CORRECTION,
    TONES,
    ToneKey,
    MAX_CHUNK_SIZE,
    CHUNK_OVERLAP,
    processInBatches,
    splitTextInChunks,
    withRetry
} from './config';
import { searchKnowledge } from './memory';

// Interfaccia per la risposta dell'AI
interface AIResponse {
    segments: any[];
    detected_location?: {
        macro?: string; // Es. "Città di Neverwinter"
        micro?: string; // Es. "Locanda del Drago"
        confidence: string; // "high" o "low"
    };
    atlas_update?: string; // Nuova descrizione del luogo (se cambiata)
    npc_updates?: Array<{
        name: string;
        description: string;
        role?: string; // Opzionale
        status?: string; // Opzionale (es. "DEAD" se muore)
    }>;
    present_npcs?: string[]; // Lista semplice di NPC presenti nella scena
}

// Interfaccia per il riassunto strutturato
export interface SummaryResponse {
    summary: string;
    title: string;
    tokens: number;
    loot?: string[];
    loot_removed?: string[]; // NUOVO: Oggetti consumati/persi
    quests?: string[];
    narrative?: string; // NUOVO: Racconto narrativo
    log?: string[]; // NUOVO: Log schematico
    // NUOVO CAMPO
    character_growth?: Array<{
        name: string;
        event: string;
        type: 'BACKGROUND' | 'TRAUMA' | 'RELATIONSHIP' | 'ACHIEVEMENT' | 'GOAL_CHANGE';
    }>;
    npc_events?: Array<{
        name: string;
        event: string;
        type: 'REVELATION' | 'BETRAYAL' | 'DEATH' | 'ALLIANCE' | 'STATUS_CHANGE' | 'GENERIC';
    }>;
    world_events?: Array<{
        event: string;
        type: 'WAR' | 'POLITICS' | 'DISCOVERY' | 'CALAMITY' | 'SUPERNATURAL' | 'GENERIC';
    }>;
}

// --- FASE 1: MAP ---
async function extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<{text: string, title: string, tokens: number}> {
    const mapPrompt = `Sei un analista di D&D.
    ${castContext}
    Estrai un elenco puntato cronologico strutturato esattamente così:
    1. Nomi di NPC incontrati e le frasi chiave che hanno pronunciato (anche se lette dalla voce del DM);
    2. Luoghi visitati;
    3. Oggetti ottenuti (Loot) con dettagli;
    4. Numeri/Danni rilevanti;
    5. Decisioni chiave dei giocatori.
    6. Dialoghi importanti e il loro contenuto.
    
    Sii conciso. Se per una categoria non ci sono dati, scrivi "Nessuno".`;

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: FAST_MODEL_NAME, // USA IL MODELLO VELOCE ED ECONOMICO
            messages: [
                { role: "system", content: mapPrompt },
                { role: "user", content: chunk }
            ],
        }));

        return {
            text: response.choices[0].message.content || "",
            title: "", // Placeholder, il titolo viene generato nella fase REDUCE
            tokens: response.usage?.total_tokens || 0
        };
    } catch (err) {
        console.error(`[Bardo] ❌ Errore Map chunk ${index + 1}:`, err);
        return { text: "", title: "", tokens: 0 };
    }
}

// --- CORREZIONE TRASCRIZIONE ---
export async function correctTranscription(segments: any[], campaignId?: number): Promise<AIResponse> {
    // 1. CHECK DISATTIVAZIONE
    if (!ENABLE_AI_TRANSCRIPTION_CORRECTION) {
        console.log("[Bardo] ⏩ Correzione AI disabilitata.");
        return { segments: segments };
    }

    // 2. SELEZIONE DINAMICA
    const useOllamaForCorrection = TRANSCRIPTION_PROVIDER === 'ollama';
    
    // Scegliamo il client (Cloud o Locale)
    // FIX: Usiamo i client espliciti per evitare conflitti se AI_PROVIDER != TRANSCRIPTION_PROVIDER
    const activeClient = useOllamaForCorrection ? ollamaClient : openAiClient;
    
    // Scegliamo il modello (Locale o Nano Cloud)
    const activeModel = useOllamaForCorrection ? LOCAL_CORRECTION_MODEL : OPEN_AI_MODEL_NANO;
    
    // Scegliamo la concorrenza (Bassa per locale, Alta per cloud)
    const activeConcurrency = useOllamaForCorrection ? 1 : 5;

    console.log(`[Bardo] 🛠️ Correzione via ${TRANSCRIPTION_PROVIDER.toUpperCase()} (Model: ${activeModel}, Threads: ${activeConcurrency})`);

    // 3. Costruzione Contesto (una tantum)
    let contextInfo = "Contesto: Sessione di gioco di ruolo (Dungeons & Dragons).";
    let currentLocationMsg = "Luogo attuale: Sconosciuto.";
    let atlasContext = "";
    let currentMacro = "";
    let currentMicro = "";

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) {
            contextInfo += `\nCampagna: "${campaign.name}".`;
            
            // @ts-ignore (se TS si lamenta dei campi nuovi non ancora nell'interfaccia type Campaign)
            const loc: LocationState = { macro: campaign.current_macro_location, micro: campaign.current_micro_location };
            
            if (loc.macro || loc.micro) {
                currentMacro = loc.macro || "";
                currentMicro = loc.micro || "";
                
                currentLocationMsg = `LUOGO ATTUALE CONOSCIUTO:
                - Macro-Regione/Città: "${loc.macro || 'Non specificato'}"
                - Micro-Luogo (Stanza/Edificio): "${loc.micro || 'Non specificato'}"`;

                // RECUPERO MEMORIA ATLANTE
                if (currentMacro && currentMicro) {
                    const lore = getAtlasEntry(campaignId, currentMacro, currentMicro);
                    if (lore) {
                        atlasContext = `\n\n[[MEMORIA DEL LUOGO (ATLANTE)]]\nEcco cosa sappiamo già di questo posto:\n"${lore}"\nUsa queste info per riconoscere nomi e contesto.`;
                    } else {
                        atlasContext = `\n\n[[MEMORIA DEL LUOGO (ATLANTE)]]\nNon abbiamo ancora informazioni su questo luogo. Se vengono descritti dettagli importanti (NPC, atmosfera, oggetti chiave), annotali.`;
                    }
                }
            }

            const characters = getCampaignCharacters(campaignId);
            if (characters.length > 0) {
                contextInfo += "\nPersonaggi Giocanti (PG):";
                characters.forEach(c => {
                    if (c.character_name) {
                        let charDesc = `\n- ${c.character_name}`;
                        if (c.race || c.class) charDesc += ` (${[c.race, c.class].filter(Boolean).join(' ')})`;
                        contextInfo += charDesc;
                    }
                });
            }
        }
    }

    // 4. Prepariamo i batch (gruppi di segmenti)
    // OTTIMIZZAZIONE: Se usiamo Ollama, riduciamo il batch size per evitare errori di sincronia
    const BATCH_SIZE = useOllamaForCorrection ? 10 : 20;

    const allBatches: any[][] = [];
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        allBatches.push(segments.slice(i, i + BATCH_SIZE));
    }

    // 5. Usiamo la funzione centralizzata processInBatches per gestire parallelismo e progress bar
    const results = await processInBatches(allBatches, activeConcurrency, async (batch, idx) => {
        const batchInput = { segments: batch };

        // Prompt Ricco Ripristinato
        const prompt = `Sei l'assistente ufficiale di trascrizione per una campagna di D&D.
${contextInfo}
${currentLocationMsg}
${atlasContext}

OBIETTIVI:
1. Correggere la trascrizione fornita (nomi propri, incantesimi, punteggiatura).
2. [CARTOGRAFO] Rilevare se i personaggi si SPOSTANO fisicamente in un nuovo luogo.
   - **Macro-Luogo**: Cambia solo se viaggiano tra città, regioni o piani (es. da "Neverwinter" a "Waterdeep").
   - **Micro-Luogo**: Cambia se entrano in un edificio, una stanza o un'area specifica (es. da "Strada" a "Taverna").
3. [STORICO] Aggiorna la descrizione del luogo ATTUALE nell'Atlante SE:
   - Ci sono nuovi dettagli significativi (nomi NPC, stato della stanza, eventi chiave).
   - O se la descrizione vecchia è obsoleta.
   - Sii conciso ma descrittivo. Se non cambia nulla di rilevante, lascia 'atlas_update' vuoto.
4. [BIOGRAFO] Rilevare informazioni sugli NPC (Non-Player Characters).
   - Se viene introdotto un nuovo NPC (es. "Sono il capitano Vane"), estrai nome e ruolo.
   - Se un NPC subisce un cambiamento drastico (es. muore, si rivela un traditore), aggiorna lo status o la descrizione.
   - Ignora i Personaggi Giocanti (PG) già noti.
5. [OSSERVATORE] Elenca TUTTI gli NPC presenti nella scena (anche se non parlano ma vengono nominati come presenti).
   - Restituisci una lista semplice di nomi in "present_npcs".

REGOLE CARTOGRAFO:
- Se rimangono dove sono, NON includere "detected_location" nel JSON.
- Se si spostano, cerca di dedurre sia il Macro che il Micro. Se il Macro non cambia, ripeti quello attuale o lascialo null.
- Sii conservativo: cambia luogo solo se i giocatori dicono esplicitamente "Andiamo alla Taverna", "Entriamo nel dungeon", etc.

ISTRUZIONI SPECIFICHE PER LA CORREZIONE:
1. Rimuovi riempitivi verbali come "ehm", "uhm", "cioè", ripetizioni inutili e balbettii.
2. Correggi i termini tecnici di D&D (es. incantesimi, mostri) usando la grafia corretta (es. "Dardo Incantato" invece di "dardo incantato").
3. [IMPORTANTE] Rileva ed ELIMINA le "allucinazioni" di Whisper: se un segmento contiene frasi come "Sottotitoli creati dalla comunità", "Amara.org" o testi totalmente fuori contesto (copyright, crediti video), DEVI restituire una stringa vuota per quel segmento o rimuovere la frase.
4. Usa i nomi dei Personaggi forniti nel contesto per correggere eventuali storpiature.
5. Mantieni il tono colloquiale ma rendilo leggibile.
6. Se il testo contiene un chiaro cambio di interlocutore (es. il DM parla in prima persona come un NPC), inserisci il nome dell'NPC tra parentesi quadre all'inizio della frase. Esempio: "[Locandiere] Benvenuti!".

IMPORTANTE:
1. Non modificare "start" e "end".
2. Non unire o dividere segmenti. Il numero di oggetti in output deve essere identico all'input.
3. Restituisci un oggetto JSON con la chiave "segments", opzionalmente "detected_location", opzionalmente "atlas_update", opzionalmente "npc_updates" e opzionalmente "present_npcs".

Esempio JSON valido:
{
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "Ciao a tutti." },
    { "start": 2.5, "end": 5.0, "text": "Benvenuti." }
  ]
}

Input:
${JSON.stringify(batchInput)}`;

        let attempts = 0;
        while (attempts < 3) { // MAX_RETRIES
            try {
                // USA LE VARIABILI DINAMICHE QUI
                const response = await withRetry(() => activeClient.chat.completions.create({
                    model: activeModel, // <--- Qui usa il modello scelto (Nano o Llama)
                    messages: [
                        { role: "system", content: "Sei un assistente che parla solo JSON valido." },
                        { role: "user", content: prompt }
                    ],
                    response_format: { type: "json_object" }
                }));

                const content = response.choices[0].message.content;
                if (!content) throw new Error("Empty");
                const parsed = JSON.parse(content);

                // VALIDAZIONE: Controlliamo che i segmenti siano validi
                const isValid = parsed.segments && Array.isArray(parsed.segments) && parsed.segments.every((s: any) => 
                    typeof s.start === 'number' && typeof s.end === 'number' && s.text !== undefined
                );

                if (isValid) return parsed; // Ritorna l'oggetto completo se valido
                
                console.warn(`[Bardo] ⚠️ Batch ${idx+1}: JSON invalido o incompleto (Tentativo ${attempts+1}/3). Riprovo...`);

            } catch (err) {
                console.warn(`[Bardo] ⚠️ Errore batch ${idx+1}: ${err} (Tentativo ${attempts+1}/3).`);
            }
            
            attempts++;
            // Attesa breve prima del retry
            await new Promise(r => setTimeout(r, 1000));
        }

        console.error(`[Bardo] ❌ Batch ${idx+1} fallito dopo 3 tentativi. Uso originale.`);
        return { segments: batch };

    }, `Correzione Trascrizione (${TRANSCRIPTION_PROVIDER})`);

    // Appiattiamo il risultato (array di oggetti -> array unico di segmenti e merge location)
    const allSegments = results.flatMap(r => r.segments || [])
        // FILTRO DI SICUREZZA FINALE
        .filter(s => s && typeof s.start === 'number' && typeof s.end === 'number' && s.text !== undefined && s.text !== null);
    
    // Cerchiamo l'ultima location rilevata (se ce ne sono multiple, l'ultima vince)
    let lastDetectedLocation = undefined;
    let lastAtlasUpdate = undefined;
    const allNpcUpdates: any[] = [];
    const allPresentNpcs: Set<string> = new Set();

    for (const res of results) {
        if (res.detected_location) {
            lastDetectedLocation = res.detected_location;
        }
        if (res.atlas_update) {
            lastAtlasUpdate = res.atlas_update;
        }
        if (res.npc_updates && Array.isArray(res.npc_updates)) {
            allNpcUpdates.push(...res.npc_updates);
        }
        if (res.present_npcs && Array.isArray(res.present_npcs)) {
            res.present_npcs.forEach((n: string) => allPresentNpcs.add(n));
        }
    }

    // LOG FINALE DI RIEPILOGO
    console.log(`[Bardo] ✅ Correzione completata: ${allSegments.length} segmenti processati.`);
    if (lastDetectedLocation) {
        console.log(`[Bardo] 📍 Nuova posizione rilevata: ${lastDetectedLocation.macro || '?'} - ${lastDetectedLocation.micro || '?'}`);
    }
    if (allNpcUpdates.length > 0) {
        console.log(`[Bardo] 👥 Aggiornamenti NPC rilevati: ${allNpcUpdates.length}`);
    }

    return {
        segments: allSegments,
        detected_location: lastDetectedLocation,
        atlas_update: lastAtlasUpdate,
        npc_updates: allNpcUpdates,
        present_npcs: Array.from(allPresentNpcs)
    };
}

// --- FUNZIONE PRINCIPALE (RIASSUNTO) ---
export async function generateSummary(sessionId: string, tone: ToneKey = 'DM'): Promise<SummaryResponse> {
    console.log(`[Bardo] 📚 Generazione Riassunto per sessione ${sessionId} (Model: ${MODEL_NAME})...`);

    const transcriptions = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId) || 0;
    const campaignId = getSessionCampaignId(sessionId);

    if (transcriptions.length === 0 && notes.length === 0) return { summary: "Nessuna trascrizione trovata.", title: "Sessione Vuota", tokens: 0 };

    const userIds = new Set(transcriptions.map(t => t.user_id));
    let castContext = "PERSONAGGI (Usa queste info per arricchire la narrazione):\n";

    if (campaignId) {
        const campaign = getCampaignById(campaignId);
        if (campaign) castContext += `CAMPAGNA: ${campaign.name}\n`;

        userIds.forEach(uid => {
            const p = getUserProfile(uid, campaignId);
            if (p.character_name) {
                let charInfo = `- **${p.character_name}**`;
                const details = [];
                if (p.race) details.push(p.race);
                if (p.class) details.push(p.class);
                if (details.length > 0) charInfo += ` (${details.join(' ')})`;
                if (p.description) charInfo += `: "${p.description}"`;
                castContext += charInfo + "\n";
            }
        });
    } else {
        castContext += "Nota: Profili personaggi non disponibili per questa sessione legacy.\n";
    }

    // --- TOTAL RECALL (CONTEXT INJECTION) ---
    let memoryContext = "";
    if (campaignId) {
        console.log(`[Bardo] 🧠 Avvio Total Recall per campagna ${campaignId}...`);
        
        // Chiamiamo la funzione che ora restituisce l'oggetto strutturato
        const snapshot = getCampaignSnapshot(campaignId);
        
        // Estraiamo i dati per il RAG
        const activeCharNames = snapshot.characters.map((c: any) => c.character_name).filter(Boolean);
        const activeQuestTitles = snapshot.quests.map((q: any) => q.title);
        const locationQuery = snapshot.location ? `${snapshot.location.macro || ''} ${snapshot.location.micro || ''}`.trim() : "";

        const promises = [];
        
        // A. Ricerca Luogo
        if (locationQuery) {
            promises.push(searchKnowledge(campaignId, `Eventi passati a ${locationQuery}`, 3).then(res => ({ type: 'LUOGO', data: res })));
        }
        
        // B. Ricerca Personaggi
        if (activeCharNames.length > 0) {
            promises.push(searchKnowledge(campaignId, `Fatti su ${activeCharNames.join(', ')}`, 3).then(res => ({ type: 'PERSONAGGI', data: res })));
        }

        // C. Ricerca Quest
        if (activeQuestTitles.length > 0) {
            promises.push(searchKnowledge(campaignId, `Dettagli quest: ${activeQuestTitles.join(', ')}`, 3).then(res => ({ type: 'MISSIONI', data: res })));
        }

        const ragResults = await Promise.all(promises);

        // Costruiamo la stringa finale che andrà nel prompt
        memoryContext = `\n[[MEMORIA DEL MONDO]]\n`;
        memoryContext += `📍 LUOGO: ${snapshot.location_context}\n`;
        if (snapshot.atlasDesc) memoryContext += `📖 DESCRIZIONE AMBIENTE: ${snapshot.atlasDesc}\n`;
        memoryContext += `⚔️ MISSIONI ATTIVE: ${snapshot.quest_context}\n`;

        ragResults.forEach(res => {
            if (res.data && res.data.length > 0) {
                memoryContext += `\nRICORDI (${res.type}):\n${res.data.map(s => `- ${s}`).join('\n')}\n`;
            }
        });
        
        memoryContext += `\n--------------------------------------------------\n`;
    }
    // ----------------------------------------

    // Ricostruzione dialogo lineare
    const allFragments = [];
    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            // NOTA: t.character_name è già il risultato di COALESCE(snapshot, current) dalla query SQL in db.ts
            const charName = t.character_name || "Sconosciuto";

            if (Array.isArray(segments)) {
                for (const seg of segments) {
                    allFragments.push({
                        absoluteTime: t.timestamp + (seg.start * 1000),
                        character: charName,
                        text: seg.text,
                        type: 'audio',
                        macro: t.macro_location,
                        micro: t.micro_location
                    });
                }
            }
        } catch (e) {}
    }

    // Aggiunta Note
    for (const n of notes) {
        const p = getUserProfile(n.user_id, campaignId || 0);
        allFragments.push({
            absoluteTime: n.timestamp,
            character: p.character_name || "Giocatore",
            text: `[NOTA UTENTE] ${n.content}`,
            type: 'note',
            macro: null,
            micro: null
        });
    }

    allFragments.sort((a, b) => a.absoluteTime - b.absoluteTime);

    let lastMacro: string | null | undefined = null;
    let lastMicro: string | null | undefined = null;

    let fullDialogue = allFragments.map(f => {
        const minutes = Math.floor((f.absoluteTime - startTime) / 60000);
        const seconds = Math.floor(((f.absoluteTime - startTime) % 60000) / 1000);
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        const prefix = f.type === 'note' ? '📝 ' : '';
        
        // Inserimento Marker di Scena
        let sceneMarker = "";
        if (f.type === 'audio' && (f.macro !== lastMacro || f.micro !== lastMicro)) {
            if (f.macro || f.micro) {
                sceneMarker = `\n--- CAMBIO SCENA: [${f.macro || "Invariato"}] - [${f.micro || "Invariato"}] ---\n`;
                lastMacro = f.macro;
                lastMicro = f.micro;
            }
        }

        return `${sceneMarker}${prefix}[${timeStr}] ${f.character}: ${f.text}`;
    }).join("\n");

    let contextForFinalStep = "";
    let accumulatedTokens = 0;

    // FASE MAP: Analisi frammenti
    if (fullDialogue.length > MAX_CHUNK_SIZE) {
        console.log(`[Bardo] 🐘 Testo lungo (${fullDialogue.length} chars). Avvio Map-Reduce.`);

        const chunks = splitTextInChunks(fullDialogue, MAX_CHUNK_SIZE, CHUNK_OVERLAP);

        // Usiamo processInBatches con barra di avanzamento
        const mapResults = await processInBatches(chunks, 5, async (chunk, index) => {
            return await extractFactsFromChunk(chunk, index, chunks.length, castContext);
        }, "Analisi Frammenti (Map Phase)");

        contextForFinalStep = mapResults.map(r => r.text).join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
        accumulatedTokens = mapResults.reduce((acc, curr) => acc + curr.tokens, 0);
    } else {
        contextForFinalStep = fullDialogue;
    }

    // FASE REDUCE: Scrittura finale
    console.log(`[Bardo] ✍️  Fase REDUCE: Scrittura racconto finale (${tone})...`);

    let reducePrompt = "";

    if (tone === 'DM') {
        // --- PROMPT IBRIDO (LOG + NARRATIVA) ---
        reducePrompt = `Sei un assistente esperto di D&D (Dungeons & Dragons). 
Analizza la seguente trascrizione grezza di una sessione di gioco.
Il tuo compito è estrarre informazioni strutturate E scrivere un riassunto narrativo.

CONTESTO:
${castContext}
${memoryContext}

Devi rispondere ESCLUSIVAMENTE con un oggetto JSON valido in questo formato esatto:
{
  "title": "Titolo evocativo della sessione",
  "narrative": "Scrivi qui un riassunto discorsivo e coinvolgente degli eventi, scritto come un racconto in terza persona al passato (es: 'Il gruppo è arrivato alla zona Ovest...'). Usa un tono epico ma conciso. Includi i colpi di scena e le interazioni principali.",
  "loot": ["lista", "degli", "oggetti", "trovati"],
  "loot_removed": ["lista", "oggetti", "persi/usati"],
  "quests": ["lista", "missioni", "accettate/completate"],
  "character_growth": [
    { 
        "name": "Nome PG", 
        "event": "Descrizione dell'evento significativo", 
        "type": "TRAUMA" 
    }
  ],
  "npc_events": [
      {
          "name": "Nome NPC",
          "event": "Descrizione dell'evento chiave",
          "type": "ALLIANCE"
      }
  ],
  "world_events": [
      {
          "event": "Descrizione dell'evento globale",
          "type": "POLITICS"
      }
  ],
  "log": [
    "[luogo - stanza] Chi -> Azione -> Risultato"
  ]
}

REGOLE IMPORTANTI:
1. "narrative": Deve essere un testo fluido, non un elenco. Racconta la storia della sessione.
2. "loot": Solo oggetti di valore, monete o oggetti magici.
3. "log": Sii conciso. Usa il formato [Luogo] Chi -> Azione.
4. Rispondi SEMPRE in ITALIANO.

REGOLE IMPORTANTI PER 'character_growth':
- Estrai SOLO eventi che cambiano la vita o la personalità del personaggio.
- Tipi validi: 
  - 'BACKGROUND' (Rivelazioni sul passato, es. 'Incontra il padre perduto').
  - 'TRAUMA' (Eventi emotivi negativi forti, es. 'Uccide un innocente per sbaglio', 'Perde un braccio').
  - 'RELATIONSHIP' (Cambiamenti nelle relazioni chiave, es. 'Si innamora di X', 'Tradisce Y').
  - 'ACHIEVEMENT' (Grandi successi personali, non solo uccidere mostri).
  - 'GOAL_CHANGE' (Cambia obiettivo di vita).
- IGNORA: Danni in combattimento, acquisti, battute, interazioni minori. Vogliamo la "Storia", non la cronaca.

REGOLE PER 'npc_events':
- Registra eventi importanti che riguardano gli NPC (Non Giocanti).
- Tipi validi:
  - 'REVELATION' (Si scopre un segreto su di lui).
  - 'BETRAYAL' (Tradisce il party o qualcuno).
  - 'DEATH' (Muore).
  - 'ALLIANCE' (Si allea con il party).
  - 'STATUS_CHANGE' (Diventa Re, viene arrestato, cambia lavoro).
- Ignora semplici interazioni commerciali o chiacchiere.

REGOLE PER 'world_events':
- Estrai SOLO eventi che cambiano il mondo di gioco o la regione.
- Tipi validi:
  - 'WAR' (Inizio/Fine guerre, battaglie campali).
  - 'POLITICS' (Incoronazioni, leggi, alleanze tra nazioni).
  - 'DISCOVERY' (Scoperta di nuove terre, antiche rovine, artefatti leggendari).
  - 'CALAMITY' (Terremoti, piaghe, distruzioni di città).
  - 'SUPERNATURAL' (Intervento di divinità, rottura del velo magico).
- Non includere le azioni dei giocatori a meno che non abbiano conseguenze su scala regionale/globale.
`;

    } else {
        // --- PROMPT NARRATIVO (BARDO) ---
        reducePrompt = `Sei un Bardo. ${TONES[tone] || TONES.EPICO}
        ${castContext}
        ${memoryContext}
        
        ISTRUZIONI DI STILE:
        - "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
        - Se le azioni di un personaggio contraddicono il suo profilo, dai priorità ai fatti accaduti nelle sessioni.
        - Attribuisci correttamente i dialoghi agli NPC specifici anche se provengono tecnicamente dalla trascrizione del Dungeon Master, basandoti sul contesto della scena.
        - Le righe marcate con 📝 [NOTA UTENTE] sono fatti certi inseriti manualmente dai giocatori. Usale come punti fermi della narrazione, hanno priorità sull'audio trascritto.
        - Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il riassunto in capitoli o paragrafi distinti basati sui luoghi.

        Usa gli appunti seguenti per scrivere un riassunto coerente della sessione.
        
        ISTRUZIONI DI FORMATTAZIONE RIGIDE:
        1. Non usare preamboli (es. "Ecco il riassunto").
        2. Non usare chiusure conversazionali (es. "Fammi sapere se...", "Spero ti piaccia").
        3. Non offrire di convertire il testo in altri formati o chiedere dettagli sul sistema di gioco.
        4. L'output deve essere un oggetto JSON valido con le seguenti chiavi:
           - "title": Un titolo evocativo per la sessione.
           - "summary": Il testo narrativo completo.
           - "loot": Array di stringhe contenente gli oggetti ottenuti (es. ["Spada +1", "100 monete d'oro"]). Se nessuno, array vuoto.
           - "loot_removed": Array di stringhe contenente gli oggetti consumati, persi o venduti. Se nessuno, array vuoto.
           - "quests": Array di stringhe contenente le missioni accettate, aggiornate o concluse. Se nessuna, array vuoto.
           - "character_growth": Array di oggetti {name, event, type} per eventi significativi dei personaggi.
        5. LUNGHEZZA MASSIMA: Il riassunto NON DEVE superare i 6500 caratteri. Sii conciso ma evocativo.`;
    }

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: MODEL_NAME, // USA IL MODELLO SMART
            messages: [
                { role: "system", content: reducePrompt },
                { role: "user", content: contextForFinalStep }
            ],
            response_format: { type: "json_object" }
        }));

        const content = response.choices[0].message.content || "{}";
        accumulatedTokens += response.usage?.total_tokens || 0;

        let parsed;
        try {
            // SANITIZZAZIONE: Rimuove i backtick del markdown se presenti (```json ... ```)
            const cleanContent = content.replace(/```json\n?|```/g, '').trim();
            parsed = JSON.parse(cleanContent);
        } catch (e) {
            console.error("[Bardo] ⚠️ Errore parsing JSON:", e);
            console.error("[Bardo] Content ricevuto:", content); // Utile per debug
            
            // Fallback: proviamo a salvare il contenuto come summary testuale
            parsed = { title: "Sessione Senza Titolo", summary: content, loot: [], loot_removed: [], quests: [] };
        }

        // MAPPING INTELLIGENTE PER RETROCOMPATIBILITÀ
        // Se il prompt ha generato "log" (nuovo formato DM), lo usiamo come "summary" (che è il campo principale visualizzato)
        // E "narrative" lo passiamo come campo extra.
        let finalSummary = parsed.summary;
        if (Array.isArray(parsed.log)) {
            finalSummary = parsed.log.join('\n');
        } else if (!finalSummary && parsed.narrative) {
            // Fallback se manca summary ma c'è narrative
            finalSummary = parsed.narrative;
        }

        return { 
            summary: finalSummary || "Errore generazione.", 
            title: parsed.title || "Sessione Senza Titolo",
            tokens: accumulatedTokens,
            loot: Array.isArray(parsed.loot) ? parsed.loot : [],
            loot_removed: Array.isArray(parsed.loot_removed) ? parsed.loot_removed : [],
            quests: Array.isArray(parsed.quests) ? parsed.quests : [],
            narrative: parsed.narrative, // NUOVO CAMPO
            log: Array.isArray(parsed.log) ? parsed.log : [], // NUOVO CAMPO
            character_growth: Array.isArray(parsed.character_growth) ? parsed.character_growth : [], // NUOVO CAMPO
            npc_events: Array.isArray(parsed.npc_events) ? parsed.npc_events : [], // NUOVO CAMPO
            world_events: Array.isArray(parsed.world_events) ? parsed.world_events : [] // NUOVO CAMPO
        };
    } catch (err: any) {
        console.error("Errore finale:", err);
        throw err;
    }
}

// --- GENERATORE BIOGRAFIA ---
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const history = getCharacterHistory(campaignId, charName);

    if (history.length === 0) {
        return `Non c'è ancora abbastanza storia scritta su ${charName}.`;
    }

    const eventsText = history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n');

    const prompt = `Sei un biografo fantasy epico.
    Scrivi la "Storia finora" del personaggio ${charName} (${charRace} ${charClass}).
    
    Usa la seguente cronologia di eventi significativi raccolti durante le sessioni:
    ${eventsText}
    
    ISTRUZIONI:
    1. Unisci gli eventi in un racconto fluido e coinvolgente.
    2. Evidenzia l'evoluzione psicologica del personaggio (es. come i traumi lo hanno cambiato).
    3. Non fare un elenco puntato, scrivi in prosa.
    4. Usa un tono solenne e introspettivo.
    5. Concludi con una frase sullo stato attuale del personaggio.`;

    try {
        const response = await openai.chat.completions.create({
            model: MODEL_NAME, // Usa un modello intelligente per la scrittura
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content || "Impossibile scrivere la biografia.";
    } catch (e) {
        console.error("Errore generazione bio:", e);
        return "Il biografo ha finito l'inchiostro.";
    }
}

// --- GENERATORE BIOGRAFIA NPC ---
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);

    // Combiniamo i dati statici (Dossier) con quelli storici (History)
    const historyText = history.length > 0 
        ? history.map((h: any) => `[${h.event_type}] ${h.description}`).join('\n')
        : "Nessun evento storico registrato.";

    const prompt = `Sei un biografo fantasy.
    Scrivi la storia dell'NPC: **${npcName}**.
    
    RUOLO ATTUALE: ${role}
    DESCRIZIONE GENERALE: ${staticDesc}
    
    CRONOLOGIA EVENTI (Apparsi nelle sessioni):
    ${historyText}
    
    ISTRUZIONI:
    1. Unisci la descrizione generale con gli eventi cronologici per creare un profilo completo.
    2. Se ci sono eventi storici, usali per spiegare come è arrivato alla situazione attuale.
    3. Se non ci sono eventi storici, basati sulla descrizione generale espandendola leggermente.
    4. Usa un tono descrittivo, come una voce di enciclopedia o un dossier segreto.`;

    try {
        const response = await openai.chat.completions.create({
            model: MODEL_NAME,
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content || "Impossibile scrivere il dossier.";
    } catch (e) {
        console.error("Errore generazione bio NPC:", e);
        return "Il dossier è bruciato.";
    }
}
