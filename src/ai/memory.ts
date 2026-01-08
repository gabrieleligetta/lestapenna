import {
    getSessionTranscript,
    getSessionStartTime,
    getSessionCampaignId,
    insertKnowledgeFragment,
    getKnowledgeFragments,
    deleteSessionKnowledge,
    getCampaignLocationById,
    findNpcDossierByName,
    listNpcs
} from '../db';
import {
    openaiEmbedClient,
    ollamaEmbedClient,
    EMBEDDING_MODEL_OPENAI,
    EMBEDDING_MODEL_OLLAMA,
    processInBatches,
    cosineSimilarity,
    withRetry,
    openai,
    FAST_MODEL_NAME
} from './config';

// --- RAG: INGESTION ---
export async function ingestSessionRaw(sessionId: string) {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) {
        console.warn(`[RAG] ⚠️ Sessione ${sessionId} senza campagna. Salto ingestione.`);
        return;
    }

    console.log(`[RAG] 🧠 Ingestione RAW per sessione ${sessionId}...`);

    // 1. Pulisci vecchi frammenti per ENTRAMBI i modelli
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OPENAI);
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OLLAMA);

    // 2. Recupera e ricostruisci il dialogo completo
    const transcriptions = getSessionTranscript(sessionId);
    if (transcriptions.length === 0) return;

    const startTime = getSessionStartTime(sessionId) || 0;

    interface DialogueLine { timestamp: number; text: string; macro?: string | null; micro?: string | null; present_npcs?: string[] }
    const lines: DialogueLine[] = [];

    for (const t of transcriptions) {
        try {
            const segments = JSON.parse(t.transcription_text);
            const npcs = t.present_npcs ? t.present_npcs.split(',') : [];
            
            // NOTA: t.character_name è già il risultato di COALESCE(snapshot, current) dalla query SQL in db.ts
            // Quindi qui stiamo usando correttamente l'identità storica se disponibile.
            const charName = t.character_name || "Sconosciuto";

            if (Array.isArray(segments)) {
                for (const seg of segments) {
                    const absTime = t.timestamp + (seg.start * 1000);
                    const mins = Math.floor((absTime - startTime) / 60000);
                    const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
                    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                    
                    lines.push({ 
                        timestamp: absTime, 
                        text: `[${timeStr}] ${charName}: ${seg.text}`,
                        macro: t.macro_location,
                        micro: t.micro_location,
                        present_npcs: npcs
                    });
                }
            }
        } catch (e) { /* Ignora errori parsing */ }
    }

    lines.sort((a, b) => a.timestamp - b.timestamp);

    // 2b. Recupera lista NPC per tagging (fallback se present_npcs è vuoto)
    const allNpcs = listNpcs(campaignId, 1000); // Recupera tutti gli NPC
    const npcNames = allNpcs.map(n => n.name);

    // 3. Sliding Window Chunking
    const fullText = lines.map(l => l.text).join("\n");
    const CHUNK_SIZE = 1000;
    const OVERLAP = 200;

    const chunks = [];
    let i = 0;
    while (i < fullText.length) {
        let end = Math.min(i + CHUNK_SIZE, fullText.length);
        if (end < fullText.length) {
            const lastNewLine = fullText.lastIndexOf('\n', end);
            if (lastNewLine > i + (CHUNK_SIZE * 0.5)) end = lastNewLine;
        }
        const chunkText = fullText.substring(i, end).trim();
        let chunkTimestamp = startTime;
        const timeMatch = chunkText.match(/\[(\d+):(\d+)\]/);
        if (timeMatch) chunkTimestamp = startTime + (parseInt(timeMatch[1]) * 60000) + (parseInt(timeMatch[2]) * 1000);

        // Recuperiamo il luogo e gli NPC dal primo segmento del chunk (approssimazione accettabile)
        // Cerchiamo la riga corrispondente nel array originale
        const firstLine = lines.find(l => l.text.includes(chunkText.substring(0, 50)));
        const macro = firstLine?.macro || null;
        const micro = firstLine?.micro || null;
        
        // MERGE INTELLIGENTE NPC:
        // Uniamo gli NPC esplicitamente taggati nel DB (present_npcs) con quelli trovati nel testo
        const dbNpcs = firstLine?.present_npcs || [];
        const textNpcs = npcNames.filter(name => chunkText.toLowerCase().includes(name.toLowerCase()));
        const mergedNpcs = Array.from(new Set([...dbNpcs, ...textNpcs]));

        if (chunkText.length > 50) chunks.push({ text: chunkText, timestamp: chunkTimestamp, macro, micro, npcs: mergedNpcs });
        if (end >= fullText.length) break;
        i = end - OVERLAP;
    }

    // 4. Embedding con Progress Bar
    // Usiamo una concorrenza sicura per gli embedding (5 richieste parallele)
    await processInBatches(chunks, 5, async (chunk, idx) => {
        const promises = [];

        // OpenAI Task
        promises.push(
            openaiEmbedClient.embeddings.create({ model: EMBEDDING_MODEL_OPENAI, input: chunk.text })
                .then(resp => ({ provider: 'openai', data: resp.data[0].embedding }))
                .catch(err => ({ provider: 'openai', error: err.message }))
        );

        // Ollama Task
        promises.push(
            ollamaEmbedClient.embeddings.create({ model: EMBEDDING_MODEL_OLLAMA, input: chunk.text })
                .then(resp => ({ provider: 'ollama', data: resp.data[0].embedding }))
                .catch(err => ({ provider: 'ollama', error: err.message }))
        );

        const results = await Promise.allSettled(promises);

        for (const res of results) {
            if (res.status === 'fulfilled') {
                const val = res.value as any;
                if (!val.error) {
                    insertKnowledgeFragment(
                        campaignId, sessionId, chunk.text, val.data,
                        val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                        chunk.timestamp,
                        chunk.macro,
                        chunk.micro,
                        chunk.npcs
                    );
                }
            }
        }
    }, "Calcolo Embeddings (RAG)");
}

// --- RAG: SEARCH ---
export async function searchKnowledge(campaignId: number, query: string, limit: number = 5): Promise<string[]> {
    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    console.log(`[RAG] 🔍 Ricerca con modello: ${model} (${provider})`);

    try {
        // 1. Calcolo Embedding Query
        const resp = await client.embeddings.create({ model: model, input: query });
        const queryVector = resp.data[0].embedding;
        
        // 2. Recupero Frammenti (già ordinati per timestamp ASC dal DB)
        let fragments = getKnowledgeFragments(campaignId, model);
        if (fragments.length === 0) return [];

        // --- RAG INVESTIGATIVO (Cross-Ref) ---
        // Identifichiamo se la query menziona NPC specifici per filtrare i risultati
        const allNpcs = listNpcs(campaignId, 1000);
        const mentionedNpcs = allNpcs.filter(npc => query.toLowerCase().includes(npc.name.toLowerCase()));
        
        if (mentionedNpcs.length > 0) {
            console.log(`[RAG] 🕵️ Rilevati NPC nella query: ${mentionedNpcs.map(n => n.name).join(', ')}. Attivo filtro investigativo.`);
            
            // Filtriamo i frammenti: teniamo solo quelli che hanno ALMENO UNO degli NPC menzionati
            // nella colonna associated_npcs
            const filteredFragments = fragments.filter(f => {
                if (!f.associated_npcs) return false;
                const fragmentNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase());
                return mentionedNpcs.some(mn => fragmentNpcs.includes(mn.name.toLowerCase()));
            });

            // Se il filtro è troppo aggressivo (0 risultati), torniamo al set completo (fallback)
            if (filteredFragments.length > 0) {
                console.log(`[RAG] 📉 Filtro applicato: da ${fragments.length} a ${filteredFragments.length} frammenti.`);
                fragments = filteredFragments;
            } else {
                console.log(`[RAG] ⚠️ Filtro investigativo ha prodotto 0 risultati. Fallback su ricerca completa.`);
            }
        }
        // -------------------------------------

        // 3. Recupero Contesto Attuale (per Boosting)
        const currentLocation = getCampaignLocationById(campaignId);
        const currentMacro = currentLocation?.macro || "";
        const currentMicro = currentLocation?.micro || "";

        // 4. Scoring & Boosting
        const scored = fragments.map((f, index) => {
            const vector = JSON.parse(f.embedding_json);
            let score = cosineSimilarity(queryVector, vector);

            // Boost Contestuale: Se il ricordo è avvenuto nel luogo dove sono ora, aumento la rilevanza
            if (currentMacro && f.macro_location === currentMacro) score += 0.05;
            if (currentMicro && f.micro_location === currentMicro) score += 0.10;

            return { ...f, score, originalIndex: index };
        });

        // 5. Ordinamento per Rilevanza
        scored.sort((a, b) => b.score - a.score);

        // 6. Selezione Top K + Espansione Temporale ("Cosa succede prima e dopo?")
        const topK = scored.slice(0, limit);
        const finalIndices = new Set<number>();

        topK.forEach(item => {
            finalIndices.add(item.originalIndex);
            
            // Espansione CAUSALE (Prima) - Solo se stessa sessione
            if (item.originalIndex - 1 >= 0) {
                const prev = fragments[item.originalIndex - 1];
                if (prev.session_id === item.session_id) {
                    finalIndices.add(item.originalIndex - 1);
                }
            }

            // Espansione CONSEGUENZIALE (Dopo) - Solo se stessa sessione
            if (item.originalIndex + 1 < fragments.length) {
                const next = fragments[item.originalIndex + 1];
                if (next.session_id === item.session_id) {
                    finalIndices.add(item.originalIndex + 1);
                }
            }
        });

        // 7. Recupero Finale Ordinato Cronologicamente
        // È cruciale che l'AI legga la storia in ordine temporale, non di rilevanza
        const finalFragments = Array.from(finalIndices)
            .sort((a, b) => a - b) // Ordina per indice (che corrisponde al timestamp)
            .map(idx => fragments[idx].content);

        return finalFragments;

    } catch (e) {
        console.error("[RAG] ❌ Errore ricerca:", e);
        return [];
    }
}

// --- RAG: ASK BARD ---
export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {
    const context = await searchKnowledge(campaignId, question, 5);
    
    // SAFETY CHECK: Troncatura contesto per evitare overflow token
    let contextText = context.length > 0
        ? "TRASCRIZIONI RILEVANTI (FONTE DI VERITÀ):\n" + context.map(c => `...\\n${c}\\n...`).join("\\n")
        : "Nessuna memoria specifica trovata.";

    const MAX_CONTEXT_CHARS = 12000;
    if (contextText.length > MAX_CONTEXT_CHARS) {
        console.warn(`[Bardo] ⚠️ Contesto troppo lungo (${contextText.length} chars). Troncatura di sicurezza.`);
        contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + "\n... [TESTO TRONCATO PER LIMITI DI MEMORIA]";
    }

    // --- GENIUS LOCI: Adattamento Tono ---
    const loc = getCampaignLocationById(campaignId);
    let atmosphere = "Sei il Bardo della campagna. Rispondi in modo neutrale ma evocativo.";

    if (loc) {
        const micro = (loc.micro || "").toLowerCase();
        const macro = (loc.macro || "").toLowerCase();

        if (micro.includes('taverna') || micro.includes('locanda') || micro.includes('pub')) {
            atmosphere = "Sei un bardo allegro e un po' brillo. Usi slang da taverna, fai battute e c'è rumore di boccali in sottofondo.";
        } else if (micro.includes('cripta') || micro.includes('dungeon') || micro.includes('grotta') || micro.includes('tomba')) {
            atmosphere = "Parli sottovoce, sei teso e spaventato. Descrivi i suoni inquietanti dell'ambiente oscuro. Sei molto cauto.";
        } else if (micro.includes('tempio') || micro.includes('chiesa') || micro.includes('santuario')) {
            atmosphere = "Usi un tono solenne, rispettoso e quasi religioso. Parli con voce calma e misurata.";
        } else if (macro.includes('corte') || macro.includes('castello') || macro.includes('palazzo')) {
            atmosphere = "Usi un linguaggio aulico, formale e molto rispettoso. Sei un cronista di corte attento all'etichetta.";
        } else if (micro.includes('bosco') || micro.includes('foresta') || micro.includes('giungla')) {
            atmosphere = "Sei un bardo naturalista. Parli con meraviglia della natura, noti i suoni degli animali e il fruscio delle foglie.";
        }
        
        atmosphere += `\nLUOGO ATTUALE: ${loc.macro || "Sconosciuto"} - ${loc.micro || "Sconosciuto"}.`;
    }
    // -------------------------------------

    // --- RAG SOCIALE: Iniezione Dossier NPC ---
    const relevantNpcs = findNpcDossierByName(campaignId, question);
    let socialContext = "";
    
    if (relevantNpcs.length > 0) {
        socialContext = "\n\n[[DOSSIER PERSONAGGI RILEVANTI]]\n";
        relevantNpcs.forEach((npc: any) => {
            socialContext += `- NOME: ${npc.name}\n  RUOLO: ${npc.role || 'Sconosciuto'}\n  STATO: ${npc.status}\n  INFO: ${npc.description}\n`;
        });
        socialContext += "Usa queste informazioni per arricchire la risposta, ma dai priorità ai fatti accaduti nelle trascrizioni.\n";
    }
    // ------------------------------------------

    // Prompt Ricco Ripristinato
    const systemPrompt = `${atmosphere}
    Il tuo compito è rispondere SOLO all'ULTIMA domanda posta dal giocatore, usando le trascrizioni fornite qui sotto.
    
    ${socialContext}

    ${contextText}
    
    REGOLAMENTO RIGIDO:
    1. La cronologia della chat serve SOLO per capire il contesto (es. se l'utente chiede "Come si chiama?", guarda i messaggi precedenti per capire di chi parla).
    2. NON ripetere mai le risposte già presenti nella cronologia.
    3. Rispondi in modo diretto e conciso alla domanda corrente.
    4. Se trovi informazioni contrastanti nelle trascrizioni, riportale come voci diverse.
    5. Se la risposta non è nelle trascrizioni, ammetti di non ricordare.`;

    const messages: any[] = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: FAST_MODEL_NAME, // Fast per le chat
            messages: messages as any
        }));
        return response.choices[0].message.content || "Il Bardo è muto.";
    } catch (e) {
        console.error("[Bardo] Errore risposta:", e);
        return "La mia mente è annebbiata...";
    }
}

// --- RAG: INGESTIONE BIOGRAFIA ---
export async function ingestBioEvent(campaignId: number, sessionId: string, charName: string, event: string, type: string) {
    const content = `[BIOGRAFIA: ${charName}] TIPO: ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🧠 Indicizzazione evento bio per ${charName}...`);

    // Determina provider e client (riutilizza la logica esistente in bard.ts)
    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    try {
        const resp = await client.embeddings.create({ model: model, input: content });
        const vector = resp.data[0].embedding;

        // Inseriamo nel DB come frammento di conoscenza
        // Nota: Usiamo macro/micro null perché è un evento legato alla persona, non al luogo
        insertKnowledgeFragment(
            campaignId, 
            sessionId, 
            content, 
            vector, 
            model, 
            0, // timestamp fittizio
            null, // macro
            null, // micro
            [charName] // associamo esplicitamente l'NPC/PG
        );
    } catch (e) {
        console.error(`[RAG] ❌ Errore ingestione bio ${charName}:`, e);
    }
}

// --- RAG: INGESTIONE CRONACA MONDIALE ---
export async function ingestWorldEvent(campaignId: number, sessionId: string, event: string, type: string) {
    const content = `[STORIA DEL MONDO] TIPO: ${type}. EVENTO: ${event}`;
    console.log(`[RAG] 🌍 Indicizzazione evento globale...`);

    const provider = process.env.EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai';
    const isOllama = provider === 'ollama';
    const model = isOllama ? EMBEDDING_MODEL_OLLAMA : EMBEDDING_MODEL_OPENAI;
    const client = isOllama ? ollamaEmbedClient : openaiEmbedClient;

    try {
        const resp = await client.embeddings.create({ model: model, input: content });
        const vector = resp.data[0].embedding;

        // Inseriamo nel DB (macro/micro null perché è un evento storico generale)
        insertKnowledgeFragment(
            campaignId, 
            sessionId, 
            content, 
            vector, 
            model, 
            0, 
            null, 
            null, 
            ['MONDO', 'LORE', 'STORIA'] // Tag generici
        );
    } catch (e) {
        console.error(`[RAG] ❌ Errore ingestione mondo:`, e);
    }
}
