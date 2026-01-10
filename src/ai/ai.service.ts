// FILE: src/ai/ai.service.ts

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LoggerService } from '../logger/logger.service';
import { KnowledgeRepository } from './knowledge.repository';
import { RecordingRepository } from '../audio/recording.repository';
import { SessionRepository } from '../session/session.repository';
import { CharacterRepository } from '../character/character.repository';
import { CampaignRepository } from '../campaign/campaign.repository';
import { MonitorService } from '../monitor/monitor.service';

// --- CONFIGURAZIONE TONI (Fedele a src_old) ---
const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio epico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. solo fatti narrazione in terza persona.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

// Costanti di sicurezza
const TOKEN_SAFETY_MARGIN = 1000;
const CHARS_PER_TOKEN = 3.5;

@Injectable()
export class AiService {
    private openai: OpenAI;
    private ollama: OpenAI;

    // Configurazione Modelli
    private useOllama: boolean;
    private modelName: string;
    private fastModelName: string;
    private embeddingModelOpenAI: string = "text-embedding-3-small";
    private embeddingModelOllama: string = "nomic-embed-text";
    private enableTranscriptionCorrection: boolean;
    private localCorrectionModel: string;
    private openAiModelNano: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly logger: LoggerService,
        private readonly knowledgeRepo: KnowledgeRepository,
        private readonly recordingRepo: RecordingRepository,
        private readonly sessionRepo: SessionRepository,
        private readonly characterRepo: CharacterRepository,
        private readonly campaignRepo: CampaignRepository,
        private readonly monitorService: MonitorService
    ) {
        this.useOllama = this.configService.get<string>('AI_PROVIDER') === 'ollama';
        this.enableTranscriptionCorrection = this.configService.get<string>('ENABLE_AI_TRANSCRIPTION_CORRECTION') !== 'false';

        // Configurazione Modelli
        if (this.useOllama) {
            this.modelName = this.configService.get<string>('OLLAMA_MODEL') || "llama3.2";
            this.fastModelName = this.modelName;
        } else {
            this.modelName = this.configService.get<string>('OPEN_AI_MODEL') || "gpt-5.2";
            this.fastModelName = this.configService.get<string>('OPEN_AI_MODEL_MINI') || "gpt-5-mini";
        }

        this.localCorrectionModel = this.configService.get<string>('OLLAMA_MODEL') || "llama3.2";
        this.openAiModelNano = this.configService.get<string>('OPEN_AI_MODEL_NANO') || 'gpt-5-nano';

        this.openai = new OpenAI({
            apiKey: this.configService.get<string>('OPENAI_API_KEY'),
            timeout: 600 * 1000,
        });

        this.ollama = new OpenAI({
            baseURL: this.configService.get<string>('OLLAMA_BASE_URL') || 'http://host.docker.internal:11434/v1',
            apiKey: 'ollama',
        });
    }

    // ... (METODI HELPER: getModelContextLimit, estimateTokens - LASCIATI INVARIATI) ...
    private getModelContextLimit(isOllama: boolean, modelName: string): number {
        if (isOllama) {
            if (modelName.includes("llama3.2")) return 65536;
            return 8192;
        } else {
            if (modelName.includes('nano')) return 400000;
            if (modelName.includes('gpt-4o') || modelName.includes('gpt-5')) return 128000;
            if (modelName.includes('gpt-3.5') || modelName.includes('mini')) return 16385;
            return 4096;
        }
    }

    private estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    // --- GENERAZIONE RIASSUNTO (FEDELE A src_old) ---
    async generateSummary(sessionId: string, toneKey: string = 'DM'): Promise<any> {
        try {
            const transcripts = this.recordingRepo.getTranscripts(sessionId);
            const notes = this.sessionRepo.getNotes(sessionId);

            if (transcripts.length === 0 && notes.length === 0) throw new Error("Nessuna trascrizione o nota disponibile.");

            const session = this.sessionRepo.findById(sessionId);
            const campaignId = session?.campaign_id;

            // 1. Costruzione Contesto (Cast & Memory)
            let castContext = "PERSONAGGI (Usa queste info per arricchire la narrazione):\n";
            let memoryContext = "";

            if (campaignId) {
                const campaign = this.campaignRepo.findById(campaignId);
                if (campaign) castContext += `CAMPAGNA: ${campaign.name}\n`;

                const chars = this.characterRepo.findAll(campaignId);
                const activeCharNames: string[] = [];
                chars.forEach(c => {
                    if (c.character_name) activeCharNames.push(c.character_name);
                    let charInfo = `- **${c.character_name}**`;
                    const details = [];
                    if (c.race) details.push(c.race);
                    if (c.class) details.push(c.class);
                    if (details.length > 0) charInfo += ` (${details.join(' ')})`;
                    if (c.description) charInfo += `: "${c.description}"`;
                    castContext += charInfo + "\n";
                });

                // Total Recall (RAG - Fedele alla struttura src_old)
                this.logger.log(`[AI] 🧠 Avvio Total Recall per campagna ${campaignId}...`);
                
                const loc = this.campaignRepo.getCurrentLocation(campaignId);
                const quests = this.campaignRepo.getQuests(campaignId);
                const activeQuestTitles = quests.map(q => q.title);
                const locationQuery = loc.macro ? `${loc.macro} ${loc.micro || ''}`.trim() : "";

                memoryContext += `\n[[MEMORIA DEL MONDO]]\n`;
                if (loc.macro) {
                    memoryContext += `📍 LUOGO: ${loc.macro} - ${loc.micro || ''}\n`;
                    if (loc.micro) {
                        const atlasDesc = this.campaignRepo.getAtlasEntry(campaignId, loc.macro, loc.micro);
                        if (atlasDesc) memoryContext += `📖 DESCRIZIONE AMBIENTE: ${atlasDesc}\n`;
                    }
                }
                if (quests.length > 0) memoryContext += `⚔️ MISSIONI ATTIVE: ${activeQuestTitles.join(', ')}\n`;

                // Ricerca RAG Parallela
                const promises = [];

                // A. Ricerca Luogo
                if (locationQuery) {
                    promises.push(this.searchKnowledge(String(campaignId), `Eventi passati a ${locationQuery}`, 3).then(res => ({ type: 'LUOGO', data: res })));
                }
                
                // B. Ricerca Personaggi
                if (activeCharNames.length > 0) {
                    promises.push(this.searchKnowledge(String(campaignId), `Fatti su ${activeCharNames.join(', ')}`, 3).then(res => ({ type: 'PERSONAGGI', data: res })));
                }

                // C. Ricerca Quest
                if (activeQuestTitles.length > 0) {
                    promises.push(this.searchKnowledge(String(campaignId), `Dettagli quest: ${activeQuestTitles.join(', ')}`, 3).then(res => ({ type: 'MISSIONI', data: res })));
                }

                const ragResults = await Promise.all(promises);

                ragResults.forEach(res => {
                    if (res.data && res.data.length > 0) {
                        memoryContext += `\nRICORDI (${res.type}):\n${res.data.map(s => `- ${s}`).join('\n')}\n`;
                    }
                });
                
                memoryContext += `\n--------------------------------------------------\n`;
            } else {
                castContext += "Nota: Profili personaggi non disponibili per questa sessione legacy.\n";
            }

            // 2. Ricostruzione Dialogo con Scene Markers (Logica src_old)
            const allFragments = [];
            for (const t of transcripts) {
                const charName = t.character_name || this.getCharacterName(t.user_id, sessionId);
                try {
                    const segments = JSON.parse(t.transcription_text || '[]');
                    if (Array.isArray(segments)) {
                        for (const seg of segments) {
                            allFragments.push({
                                absoluteTime: t.timestamp! + (seg.start * 1000),
                                character: charName,
                                text: seg.text,
                                type: 'audio',
                                macro: t.macro_location,
                                micro: t.micro_location
                            });
                        }
                    }
                } catch {
                    // Fallback testo raw
                    allFragments.push({
                        absoluteTime: t.timestamp || 0,
                        character: charName,
                        text: t.transcription_text,
                        type: 'audio',
                        macro: t.macro_location,
                        micro: t.micro_location
                    });
                }
            }

            // Aggiunta Note
            for (const n of notes) {
                const charName = this.getCharacterName(n.user_id, sessionId);
                allFragments.push({
                    absoluteTime: n.timestamp,
                    character: charName,
                    text: n.content,
                    type: 'note',
                    macro: null,
                    micro: null
                });
            }

            // Sort cronologico
            allFragments.sort((a, b) => a.absoluteTime - b.absoluteTime);

            // Generazione stringa con marker cambio scena
            const startTime = allFragments.length > 0 ? allFragments[0].absoluteTime : 0;
            let lastMacro: string | null | undefined = null;
            let lastMicro: string | null | undefined = null;

            let fullDialogue = allFragments.map(f => {
                const minutes = Math.floor((f.absoluteTime - startTime) / 60000);
                const seconds = Math.floor(((f.absoluteTime - startTime) % 60000) / 1000);
                const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                const prefix = f.type === 'note' ? '📝 [NOTA UTENTE] ' : '';

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

            // 3. Map-Reduce Logic
            let contextForFinalStep = fullDialogue;
            const MAX_CHUNK = this.useOllama ? 15000 : 800000;

            if (fullDialogue.length > MAX_CHUNK) {
                this.logger.log(`[AI] 🐘 Testo lungo (${fullDialogue.length} chars). Avvio Map-Reduce.`);
                const chunks = this.splitTextInChunks(fullDialogue, MAX_CHUNK, this.useOllama ? 1000 : 5000);

                // Uso processInBatches per parallelizzare
                const mapResults = await this.processInBatches(chunks, 5, async (chunk, index) => {
                    return await this.extractFactsFromChunk(chunk, index, chunks.length, castContext);
                });

                contextForFinalStep = mapResults.join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
            }

            // 4. Reduce Final Prompt (Logica src_old con TONE SWITCH)
            this.logger.log(`[AI] ✍️  Fase REDUCE: Scrittura racconto finale (${toneKey})...`);

            let reducePrompt = "";

            if (toneKey === 'DM') {
                // --- PROMPT IBRIDO (LOG + NARRATIVA) [da src_old] ---
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
- Tipi validi: 'BACKGROUND', 'TRAUMA', 'RELATIONSHIP', 'ACHIEVEMENT', 'GOAL_CHANGE'.
- IGNORA: Danni in combattimento, acquisti, battute.

REGOLE PER 'npc_events':
- Tipi validi: 'REVELATION', 'BETRAYAL', 'DEATH', 'ALLIANCE', 'STATUS_CHANGE'.

REGOLE PER 'world_events':
- Tipi validi: 'WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'SUPERNATURAL'.
`;
            } else {
                // --- PROMPT NARRATIVO (BARDO) [da src_old] ---
                const tonePrompt = TONES[toneKey as keyof typeof TONES] || TONES.EPICO;
                reducePrompt = `Sei un Bardo. ${tonePrompt}
        ${castContext}
        ${memoryContext}
        
        ISTRUZIONI DI STILE:
        - "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
        - Se le azioni di un personaggio contraddicono il suo profilo, dai priorità ai fatti accaduti nelle sessioni.
        - Attribuisci correttamente i dialoghi agli NPC specifici.
        - Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il riassunto.

        Usa gli appunti seguenti per scrivere un riassunto coerente della sessione.
        
        ISTRUZIONI DI FORMATTAZIONE RIGIDE:
        1. Non usare preamboli.
        2. Non usare chiusure conversazionali.
        3. L'output deve essere un oggetto JSON valido con le seguenti chiavi:
           - "title": Un titolo evocativo per la sessione.
           - "summary": Il testo narrativo completo.
           - "loot": Array di stringhe.
           - "loot_removed": Array di stringhe.
           - "quests": Array di stringhe.
           - "character_growth": Array di oggetti {name, event, type}.
           - "npc_events": Array di oggetti.
           - "world_events": Array di oggetti.
        5. LUNGHEZZA MASSIMA: Il riassunto NON DEVE superare i 6500 caratteri. Sii conciso ma evocativo.`;
            }

            const client = this.useOllama ? this.ollama : this.openai;
            const response = await client.chat.completions.create({
                model: this.modelName,
                messages: [
                    { role: "system", content: "Sei un assistente che risponde solo in JSON." },
                    { role: "user", content: reducePrompt + `\n\nTESTO DA ANALIZZARE:\n${contextForFinalStep.substring(0, 60000)}` }
                ],
                response_format: { type: "json_object" }
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            const content = response.choices[0].message.content || "{}";
            let parsed;
            try {
                const cleanContent = content.replace(/```json\n?|```/g, '').trim();
                parsed = JSON.parse(cleanContent);
            } catch (e) {
                this.logger.error("[AI] ⚠️ Errore parsing JSON:", e);
                parsed = { title: "Sessione Senza Titolo", summary: content, loot: [], loot_removed: [], quests: [] };
            }

            // MAPPING INTELLIGENTE PER RETROCOMPATIBILITÀ (come in src_old)
            let finalSummary = parsed.summary;
            // Se siamo in modalità DM, il campo 'log' è predominante, ma per il frontend vogliamo mostrare 'narrative' o 'log'
            if (toneKey === 'DM') {
                if (Array.isArray(parsed.log)) {
                    // Nel vecchio sistema DM, il log era il summary
                    finalSummary = parsed.log.join('\n');
                }
            }

            // Se finalSummary è vuoto, proviamo narrative
            if (!finalSummary && parsed.narrative) {
                finalSummary = parsed.narrative;
            }

            return {
                summary: finalSummary || "Errore generazione.",
                title: parsed.title || "Sessione Senza Titolo",
                loot: Array.isArray(parsed.loot) ? parsed.loot : [],
                loot_removed: Array.isArray(parsed.loot_removed) ? parsed.loot_removed : [],
                quests: Array.isArray(parsed.quests) ? parsed.quests : [],
                narrative: parsed.narrative,
                log: Array.isArray(parsed.log) ? parsed.log : [],
                character_growth: Array.isArray(parsed.character_growth) ? parsed.character_growth : [],
                npc_events: Array.isArray(parsed.npc_events) ? parsed.npc_events : [],
                world_events: Array.isArray(parsed.world_events) ? parsed.world_events : []
            };

        } catch (e: any) {
            this.monitorService.logError('AI-Summary', e.message);
            throw e;
        }
    }

    private async extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<string> {
        try {
            // --- PROMPT MAP (Fedele a src_old) ---
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

            const client = this.useOllama ? this.ollama : this.openai;
            const response = await client.chat.completions.create({
                model: this.fastModelName,
                messages: [
                    { role: "system", content: mapPrompt },
                    { role: "user", content: chunk }
                ]
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            return response.choices[0].message.content || "";
        } catch (e: any) {
            this.monitorService.logError('AI-Chunk', e.message);
            return "";
        }
    }

    // --- CORREZIONE TRASCRIZIONE (IBRIDA: ONE SHOT + BATCH FALLBACK) ---
    async correctTranscription(segments: any[], campaignId?: string): Promise<any> {
        if (!this.enableTranscriptionCorrection) {
            this.logger.log("[AI] ⏩ Correzione AI disabilitata.");
            return { segments };
        }

        const useOllama = this.configService.get<string>('TRANSCRIPTION_PROVIDER') === 'ollama';
        const activeClient = useOllama ? this.ollama : this.openai;
        const activeModel = useOllama ? this.localCorrectionModel : this.openAiModelNano;

        // 1. Recupera il Limite Tecnico del Modello
        const rawModelLimit = this.getModelContextLimit(useOllama, activeModel);

        // 2. Calcola il "Safe Input Limit"
        let maxInputTokens = 0;
        if (useOllama) {
            maxInputTokens = Math.floor(rawModelLimit / 2) - TOKEN_SAFETY_MARGIN;
        } else {
            if (activeModel.includes('nano')) {
                maxInputTokens = 128000 - TOKEN_SAFETY_MARGIN;
            } else {
                maxInputTokens = 4096 - TOKEN_SAFETY_MARGIN;
            }
        }

        // 3. Costruzione Contesto (Statico)
        const baseInstructions = `[RUOLO]
Sei un motore di correzione testo. Il tuo unico scopo è correggere errori OCR/STT in un array JSON. Non conversare.

[REGOLE]
1. Correggi ortografia e nomi propri basandoti sul GLOSSARIO.
2. Mantieni la struttura JSON intatta.
3. NON aggiungere preamboli.
4. NON includere markdown (\`\`\`json).
5. NON modificare i timestamp.
6. Se il testo è incomprensibile o solo rumore, lascialo invariato o stringa vuota, non inventare frasi.`;

        let contextInfo = `[GLOSSARIO / CONTESTO]
Campagna: Dungeons & Dragons`;

        if (campaignId) {
            const cId = Number(campaignId);
            const campaign = this.campaignRepo.findById(cId);
            if (campaign) contextInfo += `\nNome Campagna: "${campaign.name}"`;

            const chars = this.characterRepo.findAll(cId);
            if (chars.length > 0) {
                contextInfo += "\nPersonaggi (Usa questi nomi): " + chars.map(c => c.character_name).join(', ');
            }

            const loc = this.campaignRepo.getCurrentLocation(cId);
            if (loc.macro || loc.micro) {
                contextInfo += `\nLuogo: ${loc.macro || ''} - ${loc.micro || ''}`;
                if (loc.macro && loc.micro) {
                    const atlasEntry = this.campaignRepo.getAtlasEntry(cId, loc.macro, loc.micro);
                    if (atlasEntry) contextInfo += `\nInfo Luogo: "${atlasEntry.substring(0, 300)}..."`;
                }
            }
        }

        contextInfo += `\n\n[ESEMPIO]
Input: [{"text": "ciao a tulti"}]
Output: {"segments": [{"text": "ciao a tutti"}]}`;

        // 4. Calcolo Overhead e Spazio Disponibile
        const promptOverhead = this.estimateTokens(baseInstructions) + this.estimateTokens(contextInfo) + 200;
        const availableForSegments = maxInputTokens - promptOverhead;

        if (availableForSegments < 500) {
            this.logger.warn(`[AI] ⚠️ Spazio insufficiente per correzione (${availableForSegments} token). Salto.`);
            return { segments };
        }

        // 5. Strategia Ibrida
        const allSegmentsJson = JSON.stringify({ segments });
        const totalTokens = this.estimateTokens(allSegmentsJson);

        this.logger.log(`[AI] 🧮 Token Calc: Overhead ~${promptOverhead}, Disponibili ~${availableForSegments}, Richiesti ~${totalTokens}`);

        // STRATEGIA A: ONE SHOT
        if (totalTokens <= availableForSegments) {
            this.logger.log(`[AI] 🚀 One Shot Mode: Invio richiesta unica.`);
            return await this.processTranscriptionRequest(activeClient, activeModel, baseInstructions, contextInfo, segments, useOllama);
        }

        // STRATEGIA B: BATCH FALLBACK
        this.logger.log(`[AI] 🔄 Batch Mode: Input troppo grande. Divisione in blocchi...`);
        
        const finalSegments = [];
        const finalNpcUpdates = [];
        let lastDetectedLocation = undefined;
        let lastAtlasUpdate = undefined;

        let currentBatch = [];
        let currentBatchTokens = 0;

        for (const seg of segments) {
            const segJson = JSON.stringify(seg);
            const segTokens = this.estimateTokens(segJson) + 5; // margine per separatori

            // Check Riempimento
            if (currentBatchTokens + segTokens > availableForSegments) {
                // Processa Batch Corrente
                this.logger.debug(`[AI] Processing batch (${currentBatch.length} segments)...`);
                const result = await this.processTranscriptionRequest(activeClient, activeModel, baseInstructions, contextInfo, currentBatch, useOllama);
                
                // Accumula Risultati
                if (result.segments) finalSegments.push(...result.segments);
                else finalSegments.push(...currentBatch); // Fallback su originale in caso di errore parziale

                if (result.npc_updates) finalNpcUpdates.push(...result.npc_updates);
                if (result.detected_location) lastDetectedLocation = result.detected_location;
                if (result.atlas_update) lastAtlasUpdate = result.atlas_update;

                // Reset
                currentBatch = [];
                currentBatchTokens = 0;
            }

            currentBatch.push(seg);
            currentBatchTokens += segTokens;
        }

        // Processa Residuo Finale
        if (currentBatch.length > 0) {
            this.logger.debug(`[AI] Processing final batch (${currentBatch.length} segments)...`);
            const result = await this.processTranscriptionRequest(activeClient, activeModel, baseInstructions, contextInfo, currentBatch, useOllama);
            
            if (result.segments) finalSegments.push(...result.segments);
            else finalSegments.push(...currentBatch);

            if (result.npc_updates) finalNpcUpdates.push(...result.npc_updates);
            if (result.detected_location) lastDetectedLocation = result.detected_location;
            if (result.atlas_update) lastAtlasUpdate = result.atlas_update;
        }

        return {
            segments: finalSegments,
            detected_location: lastDetectedLocation,
            atlas_update: lastAtlasUpdate,
            npc_updates: finalNpcUpdates
        };
    }

    private async processTranscriptionRequest(client: any, model: string, systemPrompt: string, contextInfo: string, segments: any[], useOllama: boolean): Promise<any> {
        const segmentsJson = JSON.stringify({ segments: segments });
        const prompt = `${systemPrompt}\n\n${contextInfo}\n\n[INPUT DA ELABORARE]\n${segmentsJson}`;

        try {
            const response = await client.chat.completions.create({
                model: model,
                messages: [
                    { role: "system", content: "Sei un assistente JSON." },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0.1,
                max_tokens: useOllama ? 4096 : 16000
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            const content = response.choices[0].message.content;
            const parsed = JSON.parse(content || "{}");

            if (!parsed.segments || !Array.isArray(parsed.segments)) {
                throw new Error("JSON invalido o segmenti mancanti");
            }

            return parsed;

        } catch (e: any) {
            this.logger.error(`[AI] Errore Batch API: ${e.message}`);
            return { segments: segments }; // Fallback sicuro: ritorna originale
        }
    }

// --- GENERATORI BIOGRAFIE ---
    async generateCharacterBiography(campaignId: string, charName: string, charClass: string | null, charRace: string | null): Promise<string> {
        try {
            const history = this.characterRepo.getHistory(Number(campaignId), charName);
            if (history.length === 0) return `Non c'è ancora abbastanza storia scritta su ${charName}.`;

            const eventsText = history.map((h: any) => `[${h.event_type}] ${h.event_description}`).join('\n');
            const prompt = `Sei un biografo fantasy epico.
        Scrivi la "Storia finora" del personaggio ${charName} (${charRace} ${charClass}).
        
        CRONOLOGIA:
        ${eventsText}
        
        Scrivi in prosa solenne.`;

            const client = this.useOllama ? this.ollama : this.openai;
            const response = await client.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: prompt }]
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            return response.choices[0].message.content || "Impossibile scrivere la biografia.";
        } catch (e: any) {
            this.monitorService.logError('AI-Bio', e.message);
            return "Errore generazione biografia.";
        }
    }

    async generateNpcBiography(campaignId: string, npcName: string, role: string | null, staticDesc: string | null): Promise<string> {
        try {
            const history = this.campaignRepo.getNpcHistory(Number(campaignId), npcName);
            const historyText = history.length > 0
                ? history.map((h: any) => `[${h.event_type}] ${h.event_description}`).join('\n')
                : "Nessun evento storico registrato.";

            const prompt = `Sei un biografo fantasy.
        Scrivi la storia dell'NPC: **${npcName}**.
        RUOLO: ${role}
        DESCRIZIONE: ${staticDesc}
        
        CRONOLOGIA:
        ${historyText}
        
        Scrivi un dossier completo.`;

            const client = this.useOllama ? this.ollama : this.openai;
            const response = await client.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: prompt }]
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            return response.choices[0].message.content || "Impossibile scrivere il dossier.";
        } catch (e: any) {
            this.monitorService.logError('AI-NpcBio', e.message);
            return "Errore generazione dossier.";
        }
    }

// --- RAG: INGESTION ---
    async ingestSessionRaw(sessionId: string) {
        const transcripts = this.recordingRepo.getTranscripts(sessionId);
        if (transcripts.length === 0) return;

        const session = this.sessionRepo.findById(sessionId);
        if (!session) return;

        this.logger.log(`[AI] 🧠 Ingestione RAW per sessione ${sessionId}...`);

        // Pulizia vecchi dati
        this.knowledgeRepo.deleteBySession(sessionId, 'openai');
        this.knowledgeRepo.deleteBySession(sessionId, 'ollama');

        // Recupero NPC per tagging
        const allNpcs = this.campaignRepo.getAllNpcs(session.campaign_id);
        const npcNames = allNpcs.map(n => n.name);

        // Ricostruzione Dialogo con Timestamp
        const lines = [];
        for (const t of transcripts) {
            const charName = this.getCharacterName(t.user_id, sessionId);
            try {
                const segments = JSON.parse(t.transcription_text || '[]');
                for (const seg of segments) {
                    const absTime = t.timestamp! + (seg.start * 1000);
                    lines.push({
                        timestamp: absTime,
                        text: `${charName}: ${seg.text}`,
                        macro: t.macro_location,
                        micro: t.micro_location
                    });
                }
            } catch (e) {}
        }
        lines.sort((a, b) => a.timestamp - b.timestamp);

        // Chunking
        const fullText = lines.map(l => l.text).join("\n");
        const chunks = this.splitTextInChunks(fullText, 1000, 200);

        // Embedding & Storage
        for (const chunk of chunks) {
            const firstLine = lines.find(l => l.text.includes(chunk.substring(0, 50)));
            const macro = firstLine?.macro;
            const micro = firstLine?.micro;
            const timestamp = firstLine?.timestamp || 0;

            // NPC Extraction
            const foundNpcs = npcNames.filter(name => chunk.toLowerCase().includes(name.toLowerCase()));
            const uniqueNpcs = Array.from(new Set(foundNpcs));

            await this.ingestContent(session.campaign_id, sessionId, chunk, uniqueNpcs, timestamp, macro!, micro!);
        }

        this.logger.log(`[AI] Ingestione completata: ${chunks.length} frammenti.`);
    }

    async ingestWorldEvent(campaignId: string, sessionId: string, event: string, type: string) {
        const content = `[STORIA DEL MONDO] TIPO: ${type}. EVENTO: ${event}`;
        await this.ingestContent(Number(campaignId), sessionId, content, ['MONDO', 'LORE'], 0);
        this.logger.log(`[AI] Ingestione Mondo completata.`);
    }

    async ingestBioEvent(campaignId: string, sessionId: string, charName: string, event: string, type: string) {
        const content = `[BIOGRAFIA: ${charName}] TIPO: ${type}. EVENTO: ${event}`;
        await this.ingestContent(Number(campaignId), sessionId, content, [charName], 0);
        this.logger.log(`[AI] Ingestione Bio completata: ${charName}`);
    }

    async ingestLocationDescription(campaignId: string, macro: string, micro: string, description: string) {
        const content = `[ATLANTE: ${macro} - ${micro}] DESCRIZIONE: ${description}`;
        await this.ingestContent(Number(campaignId), "MANUAL_ENTRY", content, [], 0, macro, micro);
        this.logger.log(`[AI] Ingestione Atlante completata: ${macro}/${micro}`);
    }

// --- RAG: SEARCH KNOWLEDGE (WIKI) ---
    async searchKnowledge(campaignId: string, query: string, limit: number = 5): Promise<string[]> {
        try {
            const queryEmbedding = await this.createEmbedding(query, 'openai');

            // Recupero NPC menzionati per filtro investigativo
            const allNpcs = this.campaignRepo.getAllNpcs(Number(campaignId));
            const mentionedNpcs = allNpcs.filter(n => query.toLowerCase().includes(n.name.toLowerCase())).map(n => n.name);

            // Recupero Location per boosting
            const loc = this.campaignRepo.getCurrentLocation(Number(campaignId));

            const fragments = this.knowledgeRepo.search(
                Number(campaignId),
                queryEmbedding,
                'openai',
                limit,
                loc.macro || undefined,
                loc.micro || undefined,
                mentionedNpcs
            );

            return fragments;
        } catch (e: any) {
            this.monitorService.logError('AI-Search', e.message);
            return [];
        }
    }

// --- RAG: ASK BARD ---
    async askBard(campaignId: string, question: string, history: any[] = []): Promise<string> {
        try {
            // 1. Embedding Query
            const queryEmbedding = await this.createEmbedding(question, 'openai');

            // 2. Ricerca RAG
            // Recupero NPC menzionati nella domanda per filtro investigativo
            const allNpcs = this.campaignRepo.getAllNpcs(Number(campaignId));
            const mentionedNpcs = allNpcs.filter(n => question.toLowerCase().includes(n.name.toLowerCase())).map(n => n.name);

            // Recupero Location per boosting
            const loc = this.campaignRepo.getCurrentLocation(Number(campaignId));

            const context = this.knowledgeRepo.search(
                Number(campaignId),
                queryEmbedding,
                'openai',
                5,
                loc.macro || undefined,
                loc.micro || undefined,
                mentionedNpcs
            );

            const contextText = context.length > 0
                ? "TRASCRIZIONI RILEVANTI:\n" + context.join("\n---\n")
                : "Nessuna memoria specifica trovata.";

            // 3. Genius Loci & Social Context
            let atmosphere = "Sei il Bardo della campagna. Rispondi in modo neutrale ma evocativo.";
            if (loc.micro) {
                const m = loc.micro.toLowerCase();
                if (m.includes('taverna')) atmosphere = "Sei un bardo allegro e brillo in una taverna.";
                else if (m.includes('dungeon') || m.includes('cripta')) atmosphere = "Parli sottovoce, spaventato dall'oscurità.";
                else if (m.includes('tempio')) atmosphere = "Sei solenne e rispettoso.";
            }

            let socialContext = "";
            if (mentionedNpcs.length > 0) {
                socialContext = "\n[[DOSSIER NPC]]\n";
                mentionedNpcs.forEach(name => {
                    const npc = allNpcs.find(n => n.name === name);
                    if (npc) socialContext += `- ${npc.name} (${npc.role}): ${npc.description}\n`;
                });
            }

            // 4. Generazione Risposta
            const systemPrompt = `
          ${atmosphere}
          Rispondi alla domanda usando SOLO le informazioni fornite.
          
          ${socialContext}
          
          CONTESTO:
          ${contextText}
        `;

            const client = this.useOllama ? this.ollama : this.openai;
            const response = await client.chat.completions.create({
                model: this.fastModelName, // Usa modello "Fast"
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history,
                    { role: "user", content: question }
                ]
            });

            if (response.usage?.total_tokens) {
                this.monitorService.logTokenUsage(response.usage.total_tokens);
            }

            return response.choices[0].message.content || "Il bardo è muto.";
        } catch (e: any) {
            this.monitorService.logError('AI-Ask', e.message);
            throw e;
        }
    }

// --- HELPERS ---
    private async ingestContent(campaignId: number | null, sessionId: string, content: string, tags: string[], timestamp: number, macro?: string, micro?: string) {
        const promises = [];
        promises.push(this.createEmbedding(content, 'openai').then(d => ({ p: 'openai', d })).catch(e => ({ p: 'openai', e })));
        promises.push(this.createEmbedding(content, 'ollama').then(d => ({ p: 'ollama', d })).catch(e => ({ p: 'ollama', e })));

        const results = await Promise.allSettled(promises);
        for (const res of results) {
            if (res.status === 'fulfilled') {
                const val = res.value as any;
                if (!val.e) {
                    this.knowledgeRepo.addFragment(campaignId, sessionId, content, val.d, timestamp, macro, micro, tags, val.p, tags); // tags usati anche come associatedNpcs se sono nomi
                }
            }
        }
    }

    async createEmbedding(text: string, provider: 'openai' | 'ollama'): Promise<number[]> {
        if (provider === 'openai') {
            const res = await this.openai.embeddings.create({ model: this.embeddingModelOpenAI, input: text.substring(0, 8000) });
            if (res.usage?.total_tokens) this.monitorService.logTokenUsage(res.usage.total_tokens);
            return res.data[0].embedding;
        } else {
            const res = await this.ollama.embeddings.create({ model: this.embeddingModelOllama, input: text.substring(0, 8000) });
            // Ollama non sempre ritorna usage in modo standard, ma se lo fa:
            if ((res as any).usage?.total_tokens) this.monitorService.logTokenUsage((res as any).usage.total_tokens);
            return res.data[0].embedding;
        }
    }

    private splitTextInChunks(text: string, chunkSize: number, overlap: number): string[] {
        const chunks = [];
        let i = 0;
        while (i < text.length) {
            let end = Math.min(i + chunkSize, text.length);
            chunks.push(text.substring(i, end));
            if (end >= text.length) break;
            i = end - overlap;
        }
        return chunks;
    }

    private getCharacterName(userId: string | null, sessionId: string): string {
        const session = this.sessionRepo.findById(sessionId);
        if (!session) return "Sconosciuto";
        const char = this.characterRepo.findByUser(userId, session.campaign_id);
        return char ? char.character_name : "Giocatore";
    }

    private async processInBatches<T, R>(items: T[], batchSize: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
        const results: R[] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map((item, batchIndex) => fn(item, i + batchIndex)));
            results.push(...batchResults);
        }
        return results;
    }
}
