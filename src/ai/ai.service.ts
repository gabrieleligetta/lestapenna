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

// --- CONFIGURAZIONE TONI (Allineata con Legacy) ---
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
    
    // Configurazione Modelli (Allineata con Legacy)
    if (this.useOllama) {
        this.modelName = this.configService.get<string>('OLLAMA_MODEL') || "llama3.2";
        this.fastModelName = this.modelName; // Ollama spesso usa lo stesso modello
    } else {
        this.modelName = this.configService.get<string>('OPEN_AI_MODEL') || "gpt-5.2"; // Legacy default
        this.fastModelName = this.configService.get<string>('OPEN_AI_MODEL_MINI') || "gpt-5-mini"; // Legacy default
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

  // --- HELPER: Ottieni Limite Modello ---
  private getModelContextLimit(isOllama: boolean, modelName: string): number {
      if (isOllama) {
          // --- OLLAMA (Locale) ---
          // Llama 3.2 supporta teoricamente 128k, ma è limitato dalla VRAM/RAM assegnata.
          // Con 24GB RAM, 64k è il punto dolce (safe). 
          if (modelName.includes("llama3.2")) return 65536; 
          
          return 8192; // Fallback per modelli vecchi (Llama 2, Mistral)
      } else {
          // --- OPENAI (Cloud) ---
          // GPT-5 Nano: 400k Context / 128k Output
          if (modelName.includes('nano')) return 400000; 
          
          // GPT-4o / GPT-5 Mini: Spesso 128k Context
          if (modelName.includes('gpt-4o') || modelName.includes('gpt-5')) return 128000;
          
          // GPT-3.5 Turbo / Mini vecchi: 16k
          if (modelName.includes('gpt-3.5') || modelName.includes('mini')) return 16385;
          
          return 4096; // Fallback legacy
      }
  }

  // --- HELPER: Stima Token ---
  private estimateTokens(text: string): number {
      if (!text) return 0;
      return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // --- GENERAZIONE RIASSUNTO (MAP-REDUCE) ---
  async generateSummary(sessionId: string, toneKey: string = 'DM'): Promise<any> {
    try {
        const transcripts = this.recordingRepo.getTranscripts(sessionId);
        if (transcripts.length === 0) throw new Error("Nessuna trascrizione disponibile.");

        const session = this.sessionRepo.findById(sessionId);
        const campaignId = session?.campaign_id;

        // 1. Costruzione Contesto (Cast & Memory)
        let castContext = "PERSONAGGI:\n";
        let memoryContext = "";

        if (campaignId) {
            const chars = this.characterRepo.findAll(campaignId);
            chars.forEach(c => {
                castContext += `- ${c.character_name} (${c.race} ${c.class}): ${c.description}\n`;
            });

            // Total Recall (RAG)
            const loc = this.campaignRepo.getCurrentLocation(campaignId);
            const quests = this.campaignRepo.getQuests(campaignId);
            
            memoryContext += `\n[[MEMORIA DEL MONDO]]\n`;
            if (loc.macro) {
                memoryContext += `📍 LUOGO: ${loc.macro} - ${loc.micro}\n`;
                if (loc.micro) {
                    const atlasDesc = this.campaignRepo.getAtlasEntry(campaignId, loc.macro, loc.micro);
                    if (atlasDesc) memoryContext += `📖 DESCRIZIONE AMBIENTE: ${atlasDesc}\n`;
                }
            }
            if (quests.length > 0) memoryContext += `⚔️ MISSIONI ATTIVE: ${quests.map(q => q.title).join(', ')}\n`;
            
            // Ricerca RAG contestuale
            if (loc.macro) {
                const memories = this.knowledgeRepo.search(campaignId, await this.createEmbedding(`Eventi a ${loc.macro}`, 'openai'), 'openai', 3);
                if (memories.length > 0) memoryContext += `\nRICORDI DEL LUOGO:\n${memories.map(m => `- ${m}`).join('\n')}\n`;
            }
        }

        // 2. Ricostruzione Dialogo
        let fullText = "";
        for (const t of transcripts) {
            // FIX: Priorità al nome congelato
            const char = t.character_name || this.getCharacterName(t.user_id, sessionId);
            try {
                const segments = JSON.parse(t.transcription_text || '[]');
                const text = segments.map((s: any) => s.text).join(' ');
                if (text.trim()) fullText += `${char}: ${text}\n`;
            } catch {
                if (t.transcription_text?.trim()) fullText += `${char}: ${t.transcription_text}\n`;
            }
        }

        // 3. Map-Reduce Logic
        let contextForFinalStep = fullText;
        const MAX_CHUNK = this.useOllama ? 15000 : 800000; // Legacy limits

        if (fullText.length > MAX_CHUNK) {
            this.logger.log(`[AI] 🐘 Testo lungo (${fullText.length} chars). Avvio Map-Reduce.`);
            const chunks = this.splitTextInChunks(fullText, MAX_CHUNK, this.useOllama ? 1000 : 5000);
            const mapResults = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunkSummary = await this.extractFactsFromChunk(chunks[i], i, chunks.length, castContext);
                mapResults.push(chunkSummary);
            }
            contextForFinalStep = mapResults.join("\n\n--- SEGMENTO SUCCESSIVO ---\n\n");
        }

        // 4. Reduce Final Prompt
        const tonePrompt = TONES[toneKey as keyof typeof TONES] || TONES.DM;
        const prompt = `
          Sei un Bardo esperto. ${tonePrompt}
          Analizza la trascrizione (o i riassunti parziali) e genera un riassunto strutturato finale.
          
          CONTESTO:
          ${castContext}
          ${memoryContext}

          Output JSON:
          {
            "title": "Titolo evocativo",
            "summary": "Riassunto narrativo dettagliato",
            "loot": ["Oggetti trovati"],
            "loot_removed": ["Oggetti persi"],
            "quests": ["Missioni"],
            "character_growth": [{"name": "PG", "event": "Evento", "type": "TRAUMA/EPIPHANY"}],
            "npc_events": [{"name": "NPC", "event": "Evento", "type": "DEATH/ALLIANCE"}],
            "world_events": [{"event": "Evento globale", "type": "WAR/POLITICS"}]
          }

          TESTO DA ANALIZZARE:
          ${contextForFinalStep.substring(0, 60000)} 
        `;

        const client = this.useOllama ? this.ollama : this.openai;
        const response = await client.chat.completions.create({
          model: this.modelName, // Usa modello "Smart"
          messages: [{ role: "system", content: "Sei un assistente utile." }, { role: "user", content: prompt }],
          response_format: { type: "json_object" }
        });

        if (response.usage?.total_tokens) {
            this.monitorService.logTokenUsage(response.usage.total_tokens);
        }

        return JSON.parse(response.choices[0].message.content || "{}");
    } catch (e: any) {
        this.monitorService.logError('AI-Summary', e.message);
        throw e;
    }
  }

  private async extractFactsFromChunk(chunk: string, index: number, total: number, castContext: string): Promise<string> {
      try {
          const prompt = `Sei un analista di D&D.
          ${castContext}
          Estrai un elenco puntato cronologico:
          1. NPC incontrati e dialoghi chiave;
          2. Luoghi visitati;
          3. Loot e Oggetti;
          4. Decisioni chiave.
          
          Input (Parte ${index + 1}/${total}):
          ${chunk}`;

          const client = this.useOllama ? this.ollama : this.openai;
          const response = await client.chat.completions.create({
              model: this.fastModelName, // Usa modello "Fast"
              messages: [{ role: "user", content: prompt }]
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

  // --- CORREZIONE TRASCRIZIONE (Logica Doppia Configurazione) ---
  async correctTranscription(segments: any[], campaignId?: string): Promise<any> {
      if (!this.enableTranscriptionCorrection) {
          this.logger.log("[AI] ⏩ Correzione AI disabilitata.");
          return { segments };
      }

      const useOllama = this.configService.get<string>('TRANSCRIPTION_PROVIDER') === 'ollama';
      const activeClient = useOllama ? this.ollama : this.openai;
      const activeModel = useOllama ? this.localCorrectionModel : this.openAiModelNano;
      
      // 1. Recupera il Limite Tecnico del Modello (es. 64k o 400k)
      const rawModelLimit = this.getModelContextLimit(useOllama, activeModel);
      
      // 2. Calcola il "Safe Input Limit" (La vera doppia configurazione)
      let maxInputTokens = 0;

      if (useOllama) {
          // --- LOGICA LOCALE (Llama 3.2) ---
          // Problema: Context Window condivisa tra Input e Output.
          // Regola: Input + Output <= Context.
          // Poiché Output ~= Input (correzione testo), allora 2 * Input <= Context.
          // Limite: Context / 2.
          maxInputTokens = Math.floor(rawModelLimit / 2) - TOKEN_SAFETY_MARGIN;
          this.logger.log(`[AI] 🧠 Config Locale (${activeModel}): Split Context 50/50. Max Input: ${maxInputTokens}`);
      } else {
          // --- LOGICA CLOUD (GPT-5 Nano) ---
          if (activeModel.includes('nano')) {
               // GPT-5 Nano ha 400k Context ma "solo" 128k Output.
               // Il collo di bottiglia è l'Output. Non possiamo mandare più di 128k token
               // perché il modello non riuscirebbe a riscriverli tutti in output prima di fermarsi.
               maxInputTokens = 128000 - TOKEN_SAFETY_MARGIN;
               this.logger.log(`[AI] ☁️ Config Cloud (Nano): Limitato da Max Output. Max Input: ${maxInputTokens}`);
          } else {
               // Altri modelli OpenAI (es. GPT-4o spesso ha output limitato a 4k o 16k!)
               // Fallback conservativo per evitare troncamenti brutali.
               maxInputTokens = 4096 - TOKEN_SAFETY_MARGIN;
               this.logger.warn(`[AI] ⚠️ Modello Cloud non-Nano rilevato (${activeModel}). Limito input a 4k per sicurezza output.`);
          }
      }

      // 3. Calcolo Spazio Obbligatorio (Prompt Base + Segmenti)
      const baseInstructions = `Sei l'assistente ufficiale di trascrizione per una campagna di D&D.
OBIETTIVI:
1. Correggere la trascrizione (nomi propri, incantesimi, punteggiatura).
2. Rimuovere allucinazioni.
3. Mantieni la coerenza del discorso globale.
4. Restituisci JSON valido con chiave "segments".
5. Non modificare timestamp.`;

      const segmentsJson = JSON.stringify({ segments: segments });
      
      const mandatoryTokens = this.estimateTokens(baseInstructions) + this.estimateTokens(segmentsJson) + 200;
      let availableTokens = maxInputTokens - mandatoryTokens;

      this.logger.log(`[AI] 🧮 Token Calc: Obbligatori ~${mandatoryTokens}, Spazio Contesto Extra ~${availableTokens} (Safe Limit: ${maxInputTokens})`);

      // 4. Costruzione Contesto Dinamico (Pruning)
      let contextInfo = "Contesto: Sessione di gioco di ruolo (Dungeons & Dragons).";
      
      if (campaignId && availableTokens > 500) {
          const cId = Number(campaignId);
          const campaign = this.campaignRepo.findById(cId);
          if (campaign) contextInfo += `\nCampagna: "${campaign.name}".`;

          const chars = this.characterRepo.findAll(cId);
          if (chars.length > 0) {
              const charsText = "\nPersonaggi: " + chars.map(c => c.character_name).join(', ');
              if (this.estimateTokens(charsText) < availableTokens) {
                  contextInfo += charsText;
                  availableTokens -= this.estimateTokens(charsText);
              }
          }
          
          const loc = this.campaignRepo.getCurrentLocation(cId);
          if ((loc.macro || loc.micro) && availableTokens > 300) {
             const locHeader = `\nLuogo: ${loc.macro || ''} - ${loc.micro || ''}`;
             contextInfo += locHeader;
             availableTokens -= this.estimateTokens(locHeader);
             if (loc.macro && loc.micro) {
                  const atlasEntry = this.campaignRepo.getAtlasEntry(cId, loc.macro, loc.micro);
                  if (atlasEntry) {
                      const maxChars = availableTokens * CHARS_PER_TOKEN;
                      let atlasText = `\nInfo Atlante: "${atlasEntry}"`;
                      if (atlasText.length > maxChars) atlasText = `\nInfo Atlante: "${atlasEntry.substring(0, Math.floor(maxChars))}..."`;
                      contextInfo += atlasText;
                  }
             }
          }
      }

      // 5. Esecuzione Chiamata
      const prompt = `${baseInstructions}

${contextInfo}

Input JSON:
${segmentsJson}`;

      try {
          // Configurazione opzioni dinamica
          const completionOptions: any = {
              model: activeModel,
              messages: [
                  { role: "system", content: "Sei un assistente JSON." },
                  { role: "user", content: prompt }
              ],
              response_format: { type: "json_object" },
              temperature: 0.1,
              // IMPORTANTE: Per GPT-5 Nano possiamo osare max_tokens alti (fino a 128k), per Llama stiamo nel context.
              // Usiamo maxInputTokens come stima sicura per l'output massimo richiesto.
              max_tokens: useOllama ? 4096 : 16000 
          };

          const response = await activeClient.chat.completions.create(completionOptions);
          
           if (response.usage?.total_tokens) {
              this.monitorService.logTokenUsage(response.usage.total_tokens);
          }

          const content = response.choices[0].message.content;
          const parsed = JSON.parse(content || "{}");
          
          if (!parsed.segments || !Array.isArray(parsed.segments)) throw new Error("JSON invalido");
          
          this.logger.log(`[AI] ✅ Correzione completata: ${parsed.segments.length} segmenti.`);
          return parsed;

      } catch (e: any) {
          this.logger.error(`[AI] Errore API: ${e.message}`);
          return { segments: segments };
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
